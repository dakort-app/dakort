// What a spreadsheet cell shows and in what colour, from what ExcelJS
// reads: the value through a subset of Excel's number formats (dates,
// decimals, thousands, percent, scientific; the rest as General), and a
// colour from an ARGB value, the legacy indexed palette, or the theme
// palette with a tint. Pure, so it is unit tested.

export type Colour = { argb?: string; indexed?: number; theme?: number; tint?: number } | undefined

// The Office theme's twelve colours, in theme-index order: lt1, dk1, lt2,
// dk2, accent 1 to 6, hlink, folHlink. The defaults are Office's own, used
// when a workbook carries no theme.
export const defaultTheme = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72']

// The names in the theme's colour scheme, in theme-index order (the
// first two pairs are swapped relative to the file's order, as Excel
// numbers them).
const schemeNames = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']

// themeColours reads the twelve colours out of a theme part's XML. The
// shape is fixed (<a:dk1><a:srgbClr val="..."/></a:dk1>, or a sysClr with
// the colour in lastClr), so a pattern does, with no XML parser needed.
export function themeColours(xml: string | undefined): string[] {
  if (!xml) return defaultTheme
  const out = [...defaultTheme]
  const re = /<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>\s*<a:(?:srgbClr|sysClr)\b([^>]*)>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const i = schemeNames.indexOf(m[1])
    const hex = /(?:lastClr|val)="([0-9A-Fa-f]{6})"/.exec(m[2])?.[1]
    if (i >= 0 && hex) out[i] = hex.toUpperCase()
  }
  return out
}

// Excel's legacy palette, by index. 64 and 65 are the system text and
// window colours.
const indexedPalette = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
]

// tint lightens (tint > 0) or darkens (tint < 0) a colour the way Excel
// does: on the lightness of its HSL form.
export function tint(hex: string, t: number): string {
  if (!t) return hex
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t
  const f = (p: number, q: number, x: number) => {
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  let rr = l
  let gg = l
  let bb = l
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    rr = f(p, q, h + 1 / 3)
    gg = f(p, q, h)
    bb = f(p, q, h - 1 / 3)
  }
  const to = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0').toUpperCase()
  return to(rr) + to(gg) + to(bb)
}

// cssColour turns a cell colour into CSS, or '' for none (so the default
// applies). A theme index beyond the twelve, or the system colours, mean
// the default too.
export function cssColour(c: Colour, theme: string[] = defaultTheme): string {
  if (!c) return ''
  if (c.argb && /^[0-9A-Fa-f]{8}$/.test(c.argb)) {
    const a = parseInt(c.argb.slice(0, 2), 16)
    return a === 0 ? '' : '#' + c.argb.slice(2).toUpperCase()
  }
  if (c.argb && /^[0-9A-Fa-f]{6}$/.test(c.argb)) return '#' + c.argb.toUpperCase()
  if (c.indexed !== undefined) {
    const hex = indexedPalette[c.indexed]
    return hex ? '#' + hex : ''
  }
  if (c.theme !== undefined) {
    const hex = theme[c.theme]
    return hex ? '#' + tint(hex, c.tint ?? 0) : ''
  }
  return ''
}

// cellText is the value a cell shows before formatting: rich text joined,
// a hyperlink's text, a formula's result (undefined when the file holds
// none), an error as its code.
export type CellValue = string | number | boolean | Date | null | undefined
export type Plain = { value: CellValue; formulaNoResult?: boolean }

export function plainValue(v: unknown): Plain {
  if (v === null || v === undefined) return { value: null }
  if (typeof v !== 'object' || v instanceof Date) return { value: v as CellValue }
  const o = v as Record<string, unknown>
  if ('richText' in o && Array.isArray(o.richText)) return { value: o.richText.map((r) => String((r as { text?: unknown }).text ?? '')).join('') }
  if ('error' in o) return { value: String(o.error) }
  if ('formula' in o || 'sharedFormula' in o) {
    if (o.result === undefined || o.result === null) return { value: null, formulaNoResult: true }
    return plainValue(o.result)
  }
  if ('hyperlink' in o) return plainValue(o.text)
  if ('text' in o) return plainValue(o.text)
  return { value: String(v) }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// formatDate renders a Date through the date tokens of an Excel format
// (yyyy, mmm, dd, hh, ss, AM/PM and the rest). An "m" next to an hour or
// a second is minutes. Excel dates come from ExcelJS as UTC.
export function formatDate(d: Date, fmt: string): string {
  const ampm = /am\/pm/i.test(fmt)
  let h = d.getUTCHours()
  if (ampm) h = h % 12 || 12
  const re = /am\/pm|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|\\.|"[^"]*"|[^ymdhsa"\\]+/gi
  let out = ''
  let lastWasHour = false
  const tokens = fmt.match(re) ?? []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const low = t.toLowerCase()
    const nextIsSec = /^s/i.test(tokens[i + 1] ?? '') || (tokens[i + 1] === ':' && /^s/i.test(tokens[i + 2] ?? ''))
    switch (low) {
      case 'am/pm':
        out += d.getUTCHours() < 12 ? 'AM' : 'PM'
        break
      case 'yyyy':
        out += d.getUTCFullYear()
        break
      case 'yy':
        out += pad(d.getUTCFullYear() % 100)
        break
      case 'mmmm':
        out += months[d.getUTCMonth()]
        break
      case 'mmm':
        out += months[d.getUTCMonth()].slice(0, 3)
        break
      case 'mm':
        out += lastWasHour || nextIsSec ? pad(d.getUTCMinutes()) : pad(d.getUTCMonth() + 1)
        break
      case 'm':
        out += lastWasHour || nextIsSec ? d.getUTCMinutes() : d.getUTCMonth() + 1
        break
      case 'dddd':
        out += days[d.getUTCDay()]
        break
      case 'ddd':
        out += days[d.getUTCDay()].slice(0, 3)
        break
      case 'dd':
        out += pad(d.getUTCDate())
        break
      case 'd':
        out += d.getUTCDate()
        break
      case 'hh':
        out += pad(h)
        break
      case 'h':
        out += h
        break
      case 'ss':
        out += pad(d.getUTCSeconds())
        break
      case 's':
        out += d.getUTCSeconds()
        break
      default:
        out += t.startsWith('"') ? t.slice(1, -1) : t.startsWith('\\') ? t.slice(1) : t
    }
    lastWasHour = low === 'h' || low === 'hh' || (lastWasHour && t === ':')
  }
  return out
}

// general is Excel's General: integers whole, others to 10 significant
// digits with the trailing zeros dropped.
const general = (n: number) => (Number.isInteger(n) ? String(n) : String(parseFloat(n.toPrecision(10))))

// formatNumber renders a number through one section of an Excel format.
export function formatNumber(n: number, fmt: string): string {
  if (!fmt || /^general$/i.test(fmt)) return general(n)
  // The section for the sign: positive;negative;zero. A negative shown by
  // its own section loses the minus, as in Excel.
  const sections = fmt.split(';')
  let sec = sections[0]
  let v = n
  if (n < 0 && sections.length > 1) {
    sec = sections[1]
    v = -n
  } else if (n === 0 && sections.length > 2) sec = sections[2]
  // Colours and locale codes in brackets are not shown. Quoted text,
  // escaped characters and other literals are, where they stand: before
  // the number or after it.
  const bare = sec.replace(/\[[^\]]*\]/g, '')
  if (/[dmyhs]/i.test(bare.replace(/"[^"]*"/g, '').replace(/E[+-]/i, ''))) return formatDate(excelDate(v), bare)
  const prefix: string[] = []
  const suffix: string[] = []
  let seenDigit = false
  const core = bare.replace(/"([^"]*)"|\\(.)|([0#?.,%]|E[+-])|(.)/gi, (m, q, esc, digit, other) => {
    if (digit !== undefined) {
      seenDigit = true
      return m
    }
    ;(seenDigit ? suffix : prefix).push(q ?? esc ?? other)
    return ''
  })
  if (/E[+-]/i.test(core)) {
    const decimals = (core.split(/E/i)[0].split('.')[1] ?? '').length
    const e = v.toExponential(decimals).replace(/e([+-])(\d+)$/, (_, s, d) => 'E' + s + d.padStart(2, '0'))
    return prefix.join('') + e + suffix.join('')
  }
  const percent = core.includes('%')
  if (percent) v *= 100
  const num = core.replace(/[^0#?.,]/g, '')
  const decimals = (num.split('.')[1] ?? '').length
  const thousands = num.split('.')[0].includes(',')
  let s: string
  // A section with no digit place shows only its text ("zero").
  if (num === '') s = prefix.length || suffix.length ? '' : general(v)
  else if (thousands) s = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  else s = v.toFixed(decimals)
  return prefix.join('') + s + (percent ? '%' : '') + suffix.join('')
}

// excelDate turns a serial day number into a Date (the 1900 system, with
// Excel's 1900 leap-year quirk ignored for days after it).
export function excelDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400 * 1000))
}

export function formatValue(v: CellValue, fmt: string | undefined): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : formatDate(v, fmt && /[dmyhs]/i.test(fmt) ? fmt.split(';')[0] : 'yyyy-mm-dd')
  if (typeof v === 'number') return isFinite(v) ? formatNumber(v, fmt ?? '') : String(v)
  return String(v)
}
