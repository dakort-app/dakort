// A rule for a mouse (@media (pointer: fine)) overrides the base rule of
// the same selector, so it has to come after it: a base rule written later
// with the same selector and property wins the cascade and the mouse rule
// silently does nothing (round 35 found four: a pill that should have been
// a rounded rectangle, two hover circles, a 28 px ×). This fails on any
// such pair, in every stylesheet here.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

type Rule = { line: number; media: string[]; selectors: string[]; props: Map<string, string> }

// The selectors of a rule's head, split at the commas outside brackets, so
// :is(.run, .tasks) stays one selector rather than giving a bare .tasks.
function splitSelectors(head: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < head.length; i++) {
    const c = head[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(head.slice(from, i).trim())
      from = i + 1
    }
  }
  out.push(head.slice(from).trim())
  return out
}

function parse(src: string): Rule[] {
  // Comments out, keeping the line count.
  src = src.replace(/\/\*[\s\S]*?\*\//g, (c) => '\n'.repeat(c.split('\n').length - 1))
  const rules: Rule[] = []
  const stack: string[] = []
  let start = 0
  const lineAt = (p: number) => src.slice(0, p).split('\n').length
  for (let p = 0; p < src.length; p++) {
    const c = src[p]
    if (c === '{') {
      stack.push(src.slice(start, p).trim())
      start = p + 1
    } else if (c === '}') {
      const body = src.slice(start, p)
      const head = stack.pop()
      if (head !== undefined && !head.startsWith('@') && body.trim()) {
        const props = new Map<string, string>()
        for (const d of body.split(';')) {
          const i = d.indexOf(':')
          if (i > 0) props.set(d.slice(0, i).trim(), d.slice(i + 1).trim())
        }
        rules.push({ line: lineAt(p), media: stack.filter((h) => h.startsWith('@')), selectors: splitSelectors(head), props })
      }
      start = p + 1
    } else if (c === ';' && !stack.length) {
      start = p + 1
    }
  }
  return rules
}

test('a mouse rule is never overridden by a later base rule of the same selector', () => {
  const found: string[] = []
  for (const f of readdirSync(__dirname).filter((f) => f.endsWith('.css'))) {
    const rules = parse(readFileSync(join(__dirname, f), 'utf8'))
    rules.forEach((r, i) => {
      if (!r.media.some((m) => m.includes('pointer: fine'))) return
      for (const sel of r.selectors)
        for (const later of rules.slice(i + 1)) {
          if (later.media.length || !later.selectors.includes(sel)) continue
          const lost = [...r.props.keys()].filter((k) => later.props.has(k) && later.props.get(k) !== r.props.get(k))
          if (lost.length) found.push(`${f}:${r.line} ${sel} {${lost.join(', ')}} loses to the base rule at line ${later.line}`)
        }
    })
  }
  expect(found).toEqual([])
})

// No rule sits inside another style rule. The stylesheets do not nest, so
// one means a missing brace, and the build then nests everything after it
// (a sign-in rule without its } once swallowed the git marks, the Changes
// list and the Files | Changes switch, which drew as bare grey buttons).
test('every rule is closed before the next one opens', () => {
  const found: string[] = []
  for (const f of readdirSync(__dirname).filter((f) => f.endsWith('.css'))) {
    const src = readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => '\n'.repeat(c.split('\n').length - 1))
    const stack: string[] = []
    let start = 0
    for (let p = 0; p < src.length; p++) {
      if (src[p] === '{') {
        const head = src.slice(start, p).trim()
        if (stack.some((h) => !h.startsWith('@'))) found.push(`${f}:${src.slice(0, p).split('\n').length} ${head} opens inside ${stack.at(-1)}`)
        stack.push(head)
        start = p + 1
      } else if (src[p] === '}') {
        stack.pop()
        start = p + 1
      } else if (src[p] === ';') start = p + 1
    }
    if (stack.length) found.push(`${f}: ${stack.length} block(s) never closed`)
  }
  expect(found).toEqual([])
})
