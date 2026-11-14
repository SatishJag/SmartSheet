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
