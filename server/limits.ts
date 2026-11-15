/**
 * In-memory limits on AI drafts (one server instance): per-user drafts in flight, per-user drafts
 * per rolling hour, and drafts in flight across everyone. Each draft can cost several large model
 * calls, so a signed-in user must not be able to run them without bound.
 *
 * A batch of several items is one request in flight (one slot) but spends one hourly quota unit per
 * item: `acquire(userId, cost)`. It is admitted whole or refused whole, so nothing is spent on a
 * refusal.
 */
export interface DraftLimits {
  /** Drafts (items) per user per rolling hour. */
  perUserPerHour: number
  /** Requests (single drafts or whole batches) in flight per user. */
  perUserInFlight: number
  /** Requests in flight across all users. */
  globalInFlight: number
  /** Drafts (items) across all users per rolling hour; unlimited when omitted. */
  globalPerHour?: number
  now?: () => number
}

export type Acquired =
  | {
      ok: true
      release(): void
      /** Gives back the quota of `count` items that were never started (e.g. the client went away). Never exceeds the cost. */
      refund(count: number): void
    }
  | { ok: false; status: 429 | 503; message: string; retryAfterSeconds: number }

const HOUR_MS = 3_600_000

/** Seconds until `cost` more drafts fit under `limit`, given the ascending timestamps already counted; null if they never can. */
function retryAfter(times: number[], cost: number, limit: number, t: number): number | null {
  const expiring = times.length + cost - limit // how many of the oldest must expire first
  if (expiring > times.length || expiring < 1) return null
  return Math.max(1, Math.ceil((times[expiring - 1] + HOUR_MS - t) / 1000))
}

export function createDraftLimiter(limits: DraftLimits) {
  const now = limits.now ?? Date.now
  const inFlight = new Map<string, number>()
  const recent = new Map<string, number[]>()
  let global = 0
  let allRecent: number[] = []

  function removeLast(list: number[], value: number, count: number) {
    for (let i = list.length - 1; i >= 0 && count > 0; i--) {
      if (list[i] === value) {
        list.splice(i, 1)
        count--
      }
    }
  }

  return {
    /** One slot in flight, `cost` units (default 1) of the hourly quotas. */
    acquire(userId: string, cost = 1): Acquired {
      const t = now()
      const times = (recent.get(userId) ?? []).filter((x) => x > t - HOUR_MS)
      if (times.length > 0) recent.set(userId, times)
      else recent.delete(userId)

      if ((inFlight.get(userId) ?? 0) >= limits.perUserInFlight) {
        return { ok: false, status: 429, message: 'A draft is already being prepared for you. Wait for it to finish.', retryAfterSeconds: 10 }
      }
      if (times.length + cost > limits.perUserPerHour) {
        const wait = retryAfter(times, cost, limits.perUserPerHour, t)
        return {
          ok: false,
          status: 429,
          message:
            wait === null
              ? `This request needs ${cost} drafts, more than your limit of ${limits.perUserPerHour} per hour. Plan fewer items at once.`
              : cost > 1
                ? `This request needs ${cost} drafts and you have ${Math.max(0, limits.perUserPerHour - times.length)} left of your ${limits.perUserPerHour} per hour. Try again later or plan fewer items.`
                : `You have reached the limit of ${limits.perUserPerHour} drafts per hour. Try again later.`,
          retryAfterSeconds: wait ?? HOUR_MS / 1000,
        }
      }
      allRecent = allRecent.filter((x) => x > t - HOUR_MS)
      if (limits.globalPerHour !== undefined && allRecent.length + cost > limits.globalPerHour) {
        const wait = retryAfter(allRecent, cost, limits.globalPerHour, t)
        return {
          ok: false,
          status: 503,
          message: 'The planner has reached its hourly limit. Try again later.',
          retryAfterSeconds: wait ?? HOUR_MS / 1000,
        }
      }
      if (global >= limits.globalInFlight) {
        return { ok: false, status: 503, message: 'The planner is busy. Try again in a minute.', retryAfterSeconds: 30 }
      }

      global++
      inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1)
      const stamps = Array.from({ length: cost }, () => t)
      recent.set(userId, [...times, ...stamps])
      allRecent.push(...stamps)
      let released = false
      let refunded = 0
      return {
        ok: true,
        release() {
          if (released) return
          released = true
          global--
          const n = (inFlight.get(userId) ?? 1) - 1
          if (n > 0) inFlight.set(userId, n)
          else inFlight.delete(userId)
        },
        refund(count: number) {
          const n = Math.min(Math.max(0, Math.floor(count)), cost - refunded)
          if (n === 0) return
          refunded += n
          const own = recent.get(userId)
          if (own) removeLast(own, t, n)
          removeLast(allRecent, t, n)
        },
      }
    },
  }
}
