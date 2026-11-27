// Every space, corner, type size and control size in the CSS comes from the
// tokens at the top of styles.css, so the same thing measures the same
// everywhere. A raw px value in a spacing, radius or font-size property
// fails here, as does a px height or width up to 64 px (the size of a
// control or an icon); bigger widths are layout (a sidebar, a dialog) and
// may be px. Exceptions by rule, each for a reason: 0 and 1px (a hairline,
// a border's overlap), border widths (a line, or a transparent border that
// widens a hit area), widths over 64 px (layout: a sidebar, a dialog, a
// menu) and the token blocks themselves. A single value that must stay raw
// goes in the list below with its reason; none does today.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const dir = join(__dirname)
const spacing = /^(padding|margin|gap|row-gap|column-gap|inset|border-radius|font-size|top|right|bottom|left|scroll-padding|scroll-margin)(-[a-z-]+)?$/
const size = /^(height|min-height|max-height|width|min-width|max-width|flex-basis)$/

// file, a piece of the declaration's selector or value, and why it stays raw.
const allowed: [string, RegExp, string][] = []

type Hit = { file: string; line: number; selector: string; decl: string }

function scan(file: string): Hit[] {
  const src = readFileSync(join(dir, file), 'utf8')
  const hits: Hit[] = []
  let selector = ''
  const lines = src.split('\n')
  let comment = false
  lines.forEach((raw, i) => {
    let line = raw
    // Comments out.
    if (comment) {
      const end = line.indexOf('*/')
      if (end < 0) return
      line = line.slice(end + 2)
      comment = false
    }
    line = line.replace(/\/\*.*?\*\//g, '')
    const open = line.indexOf('/*')
    if (open >= 0) {
      line = line.slice(0, open)
      comment = true
    }
    if (line.includes('{')) {
      const sel = line.slice(0, line.indexOf('{')).trim()
      if (sel && !sel.startsWith('@')) selector = sel
    }
    // The token blocks (:root and the dark theme's) are where the px live.
    const inTokens = /^:root(\[data-theme='dark'\])?$/.test(selector)
    const m = line.match(/^\s*([a-z-]+)\s*:\s*([^;]+);?/)
    if (m && !inTokens && !m[1].startsWith('--')) {
      const [, prop, value] = m
      const px = [...value.matchAll(/(-?\d*\.?\d+)px/g)].map((x) => Math.abs(parseFloat(x[1])))
      const bad = spacing.test(prop) ? px.filter((n) => n > 1) : size.test(prop) ? px.filter((n) => n > 1 && n <= 64) : []
      if (bad.length) hits.push({ file, line: i + 1, selector, decl: `${prop}: ${value.trim()}` })
    }
  })
  return hits.filter((h) => !allowed.some(([f, re]) => f === h.file && (re.test(h.selector) || re.test(h.decl))))
}

test('spacing, corners, type and control sizes come from the tokens', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.css'))
  const hits = files.flatMap(scan)
  const report = hits.map((h) => `${h.file}:${h.line}  ${h.selector}  { ${h.decl} }`).join('\n')
  expect(report, `${hits.length} raw px values; use the tokens in styles.css`).toBe('')
})
