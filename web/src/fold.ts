// A long prompt (a big paste) shows folded: its first lines, a bar naming
// what is hidden, and its last lines, since the question is as often after
// the paste as before it. A paste with few line breaks is cut by length.

export const foldLines = 15 // more lines than this folds
export const foldChars = 1500 // or more characters than this
const headLines = 6
const tailLines = 2
const headChars = 600
const tailChars = 200

export type Fold = { head: string; tail: string; hidden: string } // hidden names what the bar opens

export function fold(text: string): Fold | null {
  const lines = text.split('\n')
  if (lines.length <= foldLines && text.length <= foldChars) return null
  // The tail's lines first, so a short question after a long one-line
  // paste is not taken into the head and cut off.
  const tailN = Math.min(tailLines, lines.length - 1)
  let tail = tailN ? lines.slice(-tailN).join('\n') : ''
  let head = lines.slice(0, Math.min(headLines, lines.length - tailN)).join('\n')
  if (head.length > headChars) head = cutEnd(head, headChars)
  if (tail.length > tailChars) tail = cutStart(tail, tailChars)
  tail = tail.replace(/^\n+/, '')
  const rest = text.length - head.length - tail.length
  if (rest < 100) return null // hardly anything to hide
  const n = lines.length - head.split('\n').length - (tail ? tail.split('\n').length : 0)
  return { head, tail, hidden: n > 1 ? `${n} more lines` : `${rest.toLocaleString()} more characters` }
}

// Cut at a space near the limit, so a word is not split.
function cutEnd(s: string, max: number) {
  const sp = s.lastIndexOf(' ', max)
  return s.slice(0, sp > max * 0.8 ? sp : max)
}

function cutStart(s: string, max: number) {
  const from = s.length - max
  const sp = s.indexOf(' ', from)
  return s.slice(sp >= 0 && sp < from + max * 0.2 ? sp + 1 : from)
}
