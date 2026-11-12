/**
 * RFC 4180 style CSV parser: quoted fields with embedded commas and newlines, doubled quotes,
 * CRLF / LF / lone CR line ends, and a leading UTF-8 BOM. Returns the records as arrays of
 * strings (ragged rows stay ragged). Blank lines are skipped. Throws on an unterminated quote
 * so a stray quote cannot silently swallow the rest of the file.
 */
// shortcut: comma delimiter only, no auto-detection of ; or tab, when users import those exports.
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let sawContent = false // anything but a bare line end since the record started (so "" is not a blank line)

  const endRecord = () => {
    if (sawContent) records.push([...record, field])
    record = []
    field = ''
    sawContent = false
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch !== '"') field += ch
      else if (src[i + 1] === '"') {
        field += '"'
        i++
      } else inQuotes = false
    } else if (ch === '"' && field === '') {
      inQuotes = sawContent = true
    } else if (ch === ',') {
      record.push(field)
      field = ''
      sawContent = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRecord()
    } else {
      field += ch
      sawContent = true
    }
  }
  if (inQuotes) throw new Error('The file has an opening quote that is never closed')
  endRecord()
  return records
}
