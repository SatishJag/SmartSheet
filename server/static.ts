/** Serves the built SPA: files from the static root, index.html for client routes. */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isPanelPath, PROCORE_ORIGINS } from '../src/procore/origins'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
}

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function plain(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(message) })
  res.end(message)
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** Who may frame a response: nobody, or (the /procore page only) Procore's own sites. */
type FramePolicy = 'none' | 'procore'

const FRAME_HEADERS: Record<FramePolicy, Record<string, string>> = {
  // The app keeps its session in this origin's storage: never let another site frame it.
  none: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
  // X-Frame-Options cannot list several origins, so the CSP alone says who may frame the panel page.
  procore: { 'Content-Security-Policy': `frame-ancestors ${PROCORE_ORIGINS.join(' ')}` },
}

async function send(req: IncomingMessage, res: ServerResponse, file: string, cache: string, frame: FramePolicy = 'none'): Promise<void> {
  const info = await stat(file)
  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': info.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    ...FRAME_HEADERS[frame],
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}

/**
 * Serves `pathname` from `root`. Requests that resolve outside the root, or touch dot-files, get
 * 404. A path without an extension that is not a file is a client route: it gets index.html.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return plain(res, 405, 'Method not allowed')
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return plain(res, 400, 'Bad request')
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return plain(res, 400, 'Bad request')

  const base = path.resolve(root)
  const target = path.resolve(base, '.' + path.posix.normalize('/' + decoded))
  const outside = target !== base && !target.startsWith(base + path.sep)
  // Covers '.', '..' and dot-files such as .env.
  const dotSegment = decoded.split('/').some((s) => s.startsWith('.'))
  if (outside || dotSegment) {
    return plain(res, 404, 'Not found')
  }

  if (target !== base && (await isFile(target))) {
    const immutable = decoded.startsWith('/assets/')
    return send(req, res, target, immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300')
  }
  if (path.extname(decoded) !== '') return plain(res, 404, 'Not found')

  const index = path.join(base, 'index.html')
  if (!(await isFile(index))) return plain(res, 404, 'The app has not been built (run npm run build).')
  // Procore shows /procore (Plan with AI only) in its side panel and full screen; nothing else is framable.
  // Decide on the raw path, exactly as the browser reports it to the page (window.location.pathname): an
  // encoded variant such as /procore%2F or /%70rocore is not the panel page and must not be framable.
  return send(req, res, index, 'no-cache', isPanelPath(pathname) ? 'procore' : 'none')
}
