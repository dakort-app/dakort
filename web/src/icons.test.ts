// One icon set at one stroke: every line icon is drawn by icons.tsx or, as
// markup, by iconpaths.ts (Lucide's icons at ICON_STROKE), so no other
// file draws its own <svg> or sets a stroke width. The browser check in
// e2e/layout.spec.ts measures the same on the rendered page. Exceptions,
// each for a reason: the context meter's ring in the composer (a chart,
// not an icon: a filled wedge in a track) and Dakort's own mark in the
// favicon.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const dir = join(__dirname)
const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))

// file, and a piece of the line that may draw its own svg.
const allowed: [string, string][] = [
  ['Composer.tsx', 'className="ctx-pie"'],
  // The brand favicon and the tab's state (favicon.ts): Dakort's mark.
  ['favicon.ts', "'<svg xmlns="],
  // The same mark drawn inline in the sidebar's head (mark.tsx).
  ['mark.tsx', 'viewBox="0 0 64 64"'],
]

test('only the icon set draws line icons', () => {
  const hits: string[] = []
  for (const f of sources) {
    if (f === 'icons.tsx' || f === 'iconpaths.ts') continue
    readFileSync(join(dir, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/<svg\b|strokeWidth|stroke-width/.test(line)) return
        if (allowed.some(([af, piece]) => af === f && line.includes(piece))) return
        hits.push(`${f}:${i + 1}: ${line.trim()}`)
      })
  }
  expect(hits).toEqual([])
})

test('the icon set has one stroke width', () => {
  const src = readFileSync(join(dir, 'icons.tsx'), 'utf8') + readFileSync(join(dir, 'iconpaths.ts'), 'utf8')
  const widths = [...src.matchAll(/(?:strokeWidth|stroke-width)[=:]\s*["{]?\s*([\d.]+|ICON_STROKE|\$\{ICON_STROKE\})/g)].map((m) => m[1])
  expect(widths.length).toBeGreaterThan(0)
  expect(widths.every((w) => /ICON_STROKE/.test(w))).toBe(true)
  expect(src).toMatch(/export const ICON_STROKE = 1\.75\b/)
  // Only Lucide's icons, from its packages: no paths copied in.
  expect(src).not.toMatch(/<path|d="M/)
  // shadcn's components draw Lucide icons of their own: the same stroke.
  expect(readFileSync(join(dir, 'index.css'), 'utf8')).toMatch(/\.lucide\s*\{[^}]*stroke-width:\s*1\.75/)
})
