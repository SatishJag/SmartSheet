import type { ReactNode } from 'react'
import { safeUrl } from './definition'

/**
 * A small, safe text format for text widgets: `#` / `##` headings, `-` bullet lists, blank lines between
 * paragraphs, and inside a line **bold**, *italic* and [links](https://example.com). Rendered as React
 * elements (never as HTML), and only http(s) links are kept.
 */

const INLINE = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/g

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<strong key={n++}>{m[1]}</strong>)
    else if (m[2] !== undefined) out.push(<em key={n++}>{m[2]}</em>)
    else {
      const href = safeUrl(m[4])
      out.push(
        href ? (
          <a key={n++} href={href} target="_blank" rel="noopener noreferrer">
            {m[3]}
          </a>
        ) : (
          m[0]
        ),
      )
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: string[] = []
  let key = 0
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(<p key={key++}>{renderInline(paragraph.join(' '))}</p>)
    paragraph = []
  }
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={key++}>
          {list.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      )
    }
    list = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    const heading = /^(#{1,2})\s+(.*)$/.exec(line)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push(heading[1] === '#' ? <h3 key={key++}>{renderInline(heading[2])}</h3> : <h4 key={key++}>{renderInline(heading[2])}</h4>)
    } else if (bullet) {
      flushParagraph()
      list.push(bullet[1])
    } else if (line === '') {
      flushParagraph()
      flushList()
    } else {
      flushList()
      paragraph.push(line)
    }
  }
  flushParagraph()
  flushList()
  return <div className="rich-text">{blocks}</div>
}
