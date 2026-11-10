// CSV and TSV read for the table view: quoted fields (with "" for a quote,
// and line breaks inside quotes), CRLF or LF, a byte order mark dropped.
// No library: the rules are short (RFC 4180) and a file tab is at most
// 2 MB (FileView's maxText).

// sniff picks the delimiter of a .csv: the one of , ; tab | that appears
// most often in the first line, outside quotes. Excel in many European
// locales writes ; and some tools write tab into a .csv.
export function sniff(text: string): string {
  const counts = new Map<string, number>()
  let quoted = false
  for (const c of text.slice(0, 64 * 1024)) {
    if (c === '"') quoted = !quoted
    else if (!quoted && (c === '\n' || c === '\r')) break
    else if (!quoted && (c === ',' || c === ';' || c === '\t' || c === '|')) counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let best = ','
  let most = 0
  for (const [c, n] of counts) {
    if (n > most) {
      best = c
      most = n
    }
  }
  return best
}

// parse splits text into rows of fields. maxRows stops early, and says so,
// so a huge file does not build millions of arrays.
export function parse(text: string, delim: string, maxRows = Infinity): { rows: string[][]; more: boolean } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = text.length
  const endRow = () => {
    row.push(field)
    field = ''
    rows.push(row)
    row = []
  }
  while (i < n) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else field += c
      i++
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delim) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      endRow()
      if (rows.length >= maxRows) return { rows, more: i + 1 < n }
    } else field += c
    i++
  }
  // The last line, unless the file ended with its line break.
  if (field !== '' || row.length) endRow()
  return { rows, more: false }
}
