import { describe, expect, it } from 'vitest'
import { createDraftLimiter } from './limits'

describe('createDraftLimiter', () => {
  const HOUR = 3_600_000
  function setup(over: Partial<Parameters<typeof createDraftLimiter>[0]> = {}) {
    let t = 0
    const limiter = createDraftLimiter({ perUserPerHour: 3, perUserInFlight: 1, globalInFlight: 2, now: () => t, ...over })
    return { limiter, advance: (ms: number) => (t += ms) }
  }

  it('allows one draft in flight per user and answers 429 for a second', () => {
    const { limiter } = setup()
    const a = limiter.acquire('u1')
    expect(a.ok).toBe(true)
    const b = limiter.acquire('u1')
    expect(b).toMatchObject({ ok: false, status: 429 })
    if (a.ok) a.release()
    expect(limiter.acquire('u1').ok).toBe(true)
  })

  it('caps drafts per user per rolling hour, with Retry-After until the oldest expires', () => {
    const { limiter, advance } = setup()
    for (let i = 0; i < 3; i++) {
      const g = limiter.acquire('u1')
      expect(g.ok).toBe(true)
      if (g.ok) g.release()
      advance(10 * 60_000)
    }
    const denied = limiter.acquire('u1')
    expect(denied).toMatchObject({ ok: false, status: 429 })
    // The first draft was 30 minutes ago: it frees up in 30 minutes.
    expect(!denied.ok && denied.retryAfterSeconds).toBe(30 * 60)
    advance(30 * 60_000)
    expect(limiter.acquire('u1').ok).toBe(true)
    void HOUR
  })

  it('caps drafts in flight across all users with 503, and frees the slot on release', () => {
    const { limiter } = setup()
    const a = limiter.acquire('u1')
    const b = limiter.acquire('u2')
    expect(a.ok && b.ok).toBe(true)
    expect(limiter.acquire('u3')).toMatchObject({ ok: false, status: 503 })
    if (a.ok) a.release()
    expect(limiter.acquire('u3').ok).toBe(true)
  })

  it('release is idempotent and a refused request does not use up the hourly quota', () => {
    const { limiter } = setup({ globalInFlight: 1 })
    const a = limiter.acquire('u1')
    expect(limiter.acquire('u2')).toMatchObject({ ok: false, status: 503 })
    if (a.ok) {
      a.release()
      a.release()
    }
    for (let i = 0; i < 3; i++) {
      const g = limiter.acquire('u2')
      expect(g.ok, `draft ${i + 1}`).toBe(true)
      if (g.ok) g.release()
    }
  })
})

describe('createDraftLimiter: total per hour (anonymous visitors can make new accounts freely)', () => {
  it('caps drafts across all users per rolling hour with 503 and Retry-After', () => {
    let t = 0
    const limiter = createDraftLimiter({ perUserPerHour: 10, perUserInFlight: 1, globalInFlight: 8, globalPerHour: 2, now: () => t })
    for (const u of ['a', 'b']) {
      const g = limiter.acquire(u)
      expect(g.ok).toBe(true)
      if (g.ok) g.release()
      t += 60_000
    }
    const denied = limiter.acquire('c')
    expect(denied).toMatchObject({ ok: false, status: 503 })
    expect(!denied.ok && denied.retryAfterSeconds).toBe(58 * 60) // the first draft expires 58 min from now
    t += 58 * 60_000
    expect(limiter.acquire('c').ok).toBe(true)
  })
})

describe('createDraftLimiter: batches (one slot, cost per item)', () => {
  function setup(over: Partial<Parameters<typeof createDraftLimiter>[0]> = {}) {
    let t = 0
    const limiter = createDraftLimiter({ perUserPerHour: 5, perUserInFlight: 1, globalInFlight: 4, globalPerHour: 8, now: () => t, ...over })
    return { limiter, advance: (ms: number) => (t += ms) }
  }

  it('a batch holds ONE slot in flight but spends one hourly unit per item', () => {
    const { limiter } = setup()
    const batch = limiter.acquire('u1', 3)
    expect(batch.ok).toBe(true)
    expect(limiter.acquire('u1')).toMatchObject({ ok: false, status: 429 }) // still one in flight per user
    if (batch.ok) batch.release()
    // 3 of 5 spent: a batch of 2 fits, then nothing more.
    const two = limiter.acquire('u1', 2)
    expect(two.ok).toBe(true)
    if (two.ok) two.release()
    expect(limiter.acquire('u1')).toMatchObject({ ok: false, status: 429 })
  })

  it('refuses a batch that would exceed the per-user quota whole, spending nothing', () => {
    const { limiter, advance } = setup()
    const first = limiter.acquire('u1', 3)
    if (first.ok) first.release()
    advance(60_000)
    const denied = limiter.acquire('u1', 3) // 3 + 3 > 5
    expect(denied).toMatchObject({ ok: false, status: 429 })
    expect(!denied.ok && denied.message).toMatch(/needs 3 drafts and you have 2 left/)
    // One unit must free up, and the oldest three share t=0: they expire 59 minutes from now.
    expect(!denied.ok && denied.retryAfterSeconds).toBe(59 * 60)
    // Nothing was spent by the refusal: 2 single drafts still fit.
    for (let i = 0; i < 2; i++) {
      const g = limiter.acquire('u1')
      expect(g.ok, `draft ${i + 1}`).toBe(true)
      if (g.ok) g.release()
    }
  })

  it('refuses a batch bigger than the whole hourly quota with an explanation', () => {
    const { limiter } = setup({ perUserPerHour: 4 })
    const denied = limiter.acquire('u1', 5)
    expect(denied).toMatchObject({ ok: false, status: 429, retryAfterSeconds: 3600 })
    expect(!denied.ok && denied.message).toMatch(/more than your limit of 4 per hour/)
  })

  it('counts every item against the global hourly quota and answers 503 with Retry-After', () => {
    const { limiter, advance } = setup()
    const a = limiter.acquire('a', 4)
    if (a.ok) a.release()
    advance(60_000)
    const b = limiter.acquire('b', 4)
    if (b.ok) b.release()
    advance(60_000)
    const denied = limiter.acquire('c', 2) // 8 + 2 > 8
    expect(denied).toMatchObject({ ok: false, status: 503 })
    // Two units must free up: the 4 oldest share t=0 and expire together, 58 minutes from now.
    expect(!denied.ok && denied.retryAfterSeconds).toBe(58 * 60)
    advance(58 * 60_000)
    expect(limiter.acquire('c', 2).ok).toBe(true)
  })

  it('a refused batch does not take the in-flight slot or any quota', () => {
    const { limiter } = setup({ globalInFlight: 1 })
    const a = limiter.acquire('u1', 2)
    expect(limiter.acquire('u2', 2)).toMatchObject({ ok: false, status: 503 })
    if (a.ok) a.release()
    const b = limiter.acquire('u2', 5)
    expect(b.ok).toBe(true) // u2 still has its whole quota
  })

  it('refund gives back the quota of items never started, at most the cost, once released or not', () => {
    const { limiter } = setup()
    const batch = limiter.acquire('u1', 4)
    expect(batch.ok).toBe(true)
    if (!batch.ok) return
    batch.refund(3)
    batch.refund(3) // only 1 left to refund
    batch.refund(-2)
    batch.release()
    // 4 spent, 4 refunded: the whole quota of 5 is free again.
    const again = limiter.acquire('u1', 5)
    expect(again.ok).toBe(true)
  })
})
