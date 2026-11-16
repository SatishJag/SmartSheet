/** Small HTTP helpers for the automation routes (kept apart from the planner routes in server/app.ts). */
import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

/** Headers for anything that carries a link token or a person's answer. */
export const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...PRIVATE_HEADERS,
    ...headers,
  })
  res.end(text)
}

export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') throw new HttpError(415, 'Send the request as application/json.')
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    req.resume()
    throw new HttpError(413, `The request body must be at most ${limit} bytes.`, { Connection: 'close' })
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > limit) {
      req.resume()
      throw new HttpError(413, `The request body must be at most ${limit} bytes.`, { Connection: 'close' })
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.')
  }
}

/**
 * The caller's address for rate limiting. Behind a proxy (Railway) the proxy appends the real client
 * address to X-Forwarded-For: with `trustProxy` the LAST entry is used (earlier ones are whatever the
 * client sent and can be forged). Without it the socket's address is used.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for']
    const last = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',').pop()?.trim()
    if (last) return last
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export interface Limiter {
  /** Records a hit; false when `key` is over its limit. */
  hit(key: string): boolean
  /** Whether `key` is over its limit, without recording anything. */
  blocked(key: string): boolean
}

/** A sliding window: at most `max` hits per `windowMs` per key. In memory (one server instance). */
export function createLimiter(max: number, windowMs: number, now: () => number = Date.now): Limiter {
  const hits = new Map<string, number[]>()
  const recent = (key: string) => {
    const t = now()
    const list = (hits.get(key) ?? []).filter((x) => x > t - windowMs)
    if (list.length > 0) hits.set(key, list)
    else hits.delete(key)
    return list
  }
  // Keep the map from growing without bound.
  let sweepAt = now() + windowMs
  const sweep = () => {
    if (now() < sweepAt) return
    sweepAt = now() + windowMs
    for (const key of [...hits.keys()]) recent(key)
  }
  return {
    hit(key) {
      sweep()
      const list = recent(key)
      if (list.length >= max) return false
      list.push(now())
      hits.set(key, list)
      return true
    },
    blocked(key) {
      return recent(key).length >= max
    },
  }
}
