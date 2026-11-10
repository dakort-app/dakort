// Codex writes its reasoning summaries as markdown: each step a bold title
// on a line of its own, then a paragraph. A thinking block shows those
// titles, one a line, and the full text on a tap; the status line of a
// running turn shows the latest one. Text without such titles (Claude's,
// when it keeps any) is shown as it is.

const titleLine = /^\s*\*\*([^*\n]+?)\*\*\s*$/

// titles lists the step titles of a thinking text, in order; none when the
// text has no title lines.
export function titles(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = titleLine.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

// latestTitle is the last complete title of a streaming thinking text, so a
// title still arriving ("**Drafting the") is not shown half written.
export function latestTitle(text: string): string | undefined {
  return titles(text).at(-1)
}
