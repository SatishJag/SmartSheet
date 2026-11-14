/**
 * In-memory limits on AI drafts (one server instance): per-user drafts in flight, per-user drafts
 * per rolling hour, and drafts in flight across everyone. Each draft can cost several large model
 * calls, so a signed-in user must not be able to run them without bound.
 */
export interface DraftLimits {
  perUserPerHour: number
  perUserInFlight: number
  globalInFlight: number
  now?: () => number
}

export type Acquired =
  | { ok: true; release(): void }
  | { ok: false; status: 429 | 503; message: string; retryAfterSeconds: number }

const HOUR_MS = 3_600_000

export function createDraftLimiter(limits: DraftLimits) {
  const now = limits.now ?? Date.now
  const inFlight = new Map<string, number>()
  const recent = new Map<string, number[]>()
  let global = 0

  return {
    acquire(userId: string): Acquired {
      const t = now()
      const times = (recent.get(userId) ?? []).filter((x) => x > t - HOUR_MS)
      if (times.length > 0) recent.set(userId, times)
      else recent.delete(userId)

      if ((inFlight.get(userId) ?? 0) >= limits.perUserInFlight) {
        return { ok: false, status: 429, message: 'A draft is already being prepared for you. Wait for it to finish.', retryAfterSeconds: 10 }
      }
      if (times.length >= limits.perUserPerHour) {
        const retryAfterSeconds = Math.max(1, Math.ceil((times[0] + HOUR_MS - t) / 1000))
        return {
          ok: false,
          status: 429,
          message: `You have reached the limit of ${limits.perUserPerHour} drafts per hour. Try again later.`,
          retryAfterSeconds,
        }
      }
      if (global >= limits.globalInFlight) {
        return { ok: false, status: 503, message: 'The planner is busy. Try again in a minute.', retryAfterSeconds: 30 }
      }

      global++
      inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1)
      recent.set(userId, [...times, t])
      let released = false
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
      }
    },
  }
}
