// One Markdown renderer for transcripts and .md files. Raw HTML stays
// escaped: replies and files can quote fetched web pages, and what renders
// here runs with the app's cookie. Math ($...$, $$...$$) goes through
// KaTeX, loaded the first time a text has a dollar sign; the plugin cuts
// math out before Markdown runs, so `a_1` inside it is never italics.
// Code blocks get a header with their language and a Copy button, and
// syntax colours once their language's parser is in (syntax.ts, loaded
// the first time a block names one; the same re-render as math).

import MarkdownIt from 'markdown-it'
import { iconHTML } from './iconpaths'

export type RenderOptions = {
  // Rewrites a relative image or link target, for files in a folder.
  resolve?: (href: string, kind: 'image' | 'link') => string
}

function make() {
  const md = new MarkdownIt({ html: false, linkify: true, highlight: (code, info) => highlightCode(code, info) })
  const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx]
    const href = String(t.attrGet('href') ?? '')
    const opts = env as RenderOptions
    if (isRelative(href) && opts?.resolve) {
      t.attrSet('href', opts.resolve(href, 'link'))
      t.attrSet('data-rel', href)
    } else {
      t.attrSet('target', '_blank')
      t.attrSet('rel', 'noopener noreferrer')
    }
    return defaultLink(tokens, idx, options, env, self)
  }
  const defaultImage = md.renderer.rules.image!
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const t = tokens[idx]
    const src = String(t.attrGet('src') ?? '')
    const opts = env as RenderOptions
    if (isRelative(src) && opts?.resolve) t.attrSet('src', opts.resolve(src, 'image'))
    t.attrSet('loading', 'lazy')
    return defaultImage(tokens, idx, options, env, self)
  }
  // A code block gets a header strip with its language and a Copy button,
  // outside the <pre> so a block that scrolls sideways does not take the
  // button with it, and the button covers no code (it sat over the first
  // line). Markdown handles the click (the HTML is a string here).
  for (const rule of ['fence', 'code_block'] as const) {
    const plainRule = md.renderer.rules[rule]!
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      const lang = rule === 'fence' ? tokens[idx].info.trim().split(/\s+/)[0] : ''
      const head = `<div class="code-head"><span class="code-lang">${md.utils.escapeHtml(lang)}</span>${copyButton}</div>`
      return `<div class="code-block">${head}${plainRule(tokens, idx, options, env, self)}</div>\n`
    }
  }
  // YAML front matter (a SKILL.md's or an agent's name and description)
  // is a quiet block of names and values, not a rule and a heading.
  md.block.ruler.before('hr', 'front_matter', frontMatterRule, { alt: [] })
  md.renderer.rules.front_matter = (tokens, idx, _o, _e, self) => frontMatterHTML(tokens[idx].content, self.renderAttrs(tokens[idx]))
  // Short inline code (an identifier, a path) does not break at its hyphens.
  const codeInline = md.renderer.rules.code_inline!
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    if (tokens[idx].content.length <= 24) tokens[idx].attrJoin('class', 'nb')
    return codeInline(tokens, idx, options, env, self)
  }
  md.core.ruler.push('table_columns', (state) => markColumns(state.tokens))
  md.core.ruler.push('source_lines', (state) => markLines(state.tokens))
  // Each top-level block takes its direction from its own text (a reply in
  // Arabic or Hebrew reads right to left, its bullets, quote bar and
  // columns with it). Only the outermost: a block inside one with its own
  // dir is skipped when the outer one resolves, and set it to the default.
  md.core.ruler.push('dir_auto', (state) => {
    for (const t of state.tokens) if (t.level === 0 && /^(paragraph|bullet_list|ordered_list|blockquote|heading|table)_open$/.test(t.type)) t.attrSet('dir', 'auto')
  })
  // Before linkify (an inline rule here), which would otherwise cut the
  // URL out of the src attribute.
  md.inline.ruler.before('linkify', 'img_tag', imgTagRule)
  return md
}

type BlockState = { src: string; bMarks: number[]; eMarks: number[]; tShift: number[]; line: number; push(type: string, tag: string, nesting: 0): Tok & { map: [number, number] | null } }

function frontMatterRule(state: BlockState, start: number, end: number, silent: boolean): boolean {
  const line = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n])
  if (start !== 0 || line(0) !== '---') return false
  let close = 1
  while (close < end && line(close) !== '---' && line(close) !== '...') close++
  if (close >= end || close === 1) return false
  if (silent) return true
  const t = state.push('front_matter', 'dl', 0)
  t.content = state.src.slice(state.bMarks[1], state.eMarks[close - 1])
  t.map = [0, close + 1]
  state.line = close + 1
  return true
}

const escapeHTML = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Top-level "name: value" lines; an indented or list line continues the
// value above it.
function frontMatterHTML(yaml: string, attrs: string): string {
  const rows: [string, string][] = []
  for (const l of yaml.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l)
    if (m) rows.push([m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')])
    else if (rows.length && l.trim()) rows[rows.length - 1][1] += (rows[rows.length - 1][1] ? ' ' : '') + l.trim()
  }
  return `<dl class="front-matter"${attrs}>${rows.map(([k, v]) => `<div><dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd></div>`).join('')}</dl>\n`
}

// READMEs on GitHub size a picture with an <img> tag, which Markdown
// cannot. With raw HTML off, the tag would show as text, so a tag with
// nothing but src, alt, width and height (quoted, no other attribute, so
// no handler or style) becomes the image it names, sized as asked. The
// src goes through the same relative-path rewrite as a Markdown image.
const imgTag = /<img\s+((?:(?:src|alt|width|height)="[^"<>]*"\s*)+)\/?>/y
const imgAttr = /(src|alt|width|height)="([^"<>]*)"/g

type InlineState = {
  src: string
  pos: number
  push(type: string, tag: string, nesting: 0 | 1 | -1): Tok & { attrSet(name: string, value: string): void; children: Tok[] | null }
  Token: new (type: string, tag: string, nesting: 0 | 1 | -1) => Tok
}

function imgTagRule(state: InlineState, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false
  imgTag.lastIndex = state.pos
  const m = imgTag.exec(state.src)
  if (!m) return false
  const attrs: Record<string, string> = {}
  for (const a of m[1].matchAll(imgAttr)) attrs[a[1]] = a[2]
  if (!attrs.src) return false
  if (!silent) {
    const img = state.push('image', 'img', 0)
    img.attrSet('src', attrs.src)
    img.attrSet('alt', '')
    if (attrs.width) img.attrSet('width', attrs.width)
    if (attrs.height) img.attrSet('height', attrs.height)
    const alt = new state.Token('text', '', 0)
    alt.content = attrs.alt ?? ''
    img.content = alt.content
    img.children = [alt]
  }
  state.pos += m[0].length
  return true
}

// A table's short columns do not wrap and its long ones keep some width.
// Laid out as it came, a table with one column of sentences gave that one
// nearly all the width and cut the others down to their longest word, one
// word a line ("Moderate, / needs / LibreOffice"); it never scrolled, as
// squeezing always made it fit. Now the long column wraps and a table too
// wide for the screen scrolls.
const shortCell = 30 // characters, with Markdown's marks left out

type Tok = {
  type: string
  content: string
  map?: [number, number] | null
  nesting: number
  hidden?: boolean
  attrJoin(name: string, value: string): void
  attrSet(name: string, value: string): void
}

// Each block carries the source line it starts at, 1-based, so a file's
// Preview and Source can meet at the same place (FileView). Nested blocks
// too: a long list is one block, and its items are where the reader is.
// A hidden token (the paragraph of a tight list item) renders nothing.
function markLines(tokens: Tok[]) {
  for (const t of tokens) {
    if (t.map && t.nesting >= 0 && !t.hidden) t.attrSet('data-line', String(t.map[0] + 1))
  }
}

function markColumns(tokens: Tok[]) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'table_open') continue
    const cells: { tok: Tok; col: number }[] = []
    const longest: number[] = []
    const numeric: boolean[] = []
    let col = 0
    let j = i + 1
    for (; j < tokens.length && tokens[j].type !== 'table_close'; j++) {
      const t = tokens[j]
      if (t.type === 'tr_open') col = 0
      if (t.type !== 'th_open' && t.type !== 'td_open') continue
      const len = (tokens[j + 1]?.type === 'inline' ? tokens[j + 1].content : '').replace(/[*_`]/g, '').length
      longest[col] = Math.max(longest[col] ?? 0, len)
      if (t.type === 'td_open') {
        const text = (tokens[j + 1]?.type === 'inline' ? tokens[j + 1].content : '').trim()
        numeric[col] = (numeric[col] ?? true) && /^([+\-−]?[\d.,]+\s*(%|[kKMG]B?|ms|s)?)?$/.test(text)
      }
      cells.push({ tok: t, col: col++ })
    }
    // Columns of numbers line up on the right.
    for (const c of cells) c.tok.attrJoin('class', (longest[c.col] <= shortCell ? 'short' : 'long') + (numeric[c.col] ? ' num' : ''))
    i = j
  }
}

// The icons are icons.tsx's CopyIcon and CheckIcon at the dense size; CSS
// shows one.
const copyButton =
  '<button type="button" class="code-copy" title="Copy" aria-label="Copy code">' +
  iconHTML('copy', true) +
  iconHTML('check', true) +
  '<span class="code-copy-label">Copy</span><span class="code-copy-done">Copied</span>' +
  '</button>'

// join resolves a relative link against the folder of the file it is in.
// It lives here, not with the file view, so its unit test loads no part of
// the page (the view's imports reach the store, which needs a document).
export function join(fromFile: string, href: string): string {
  const parts = fromFile.split('/').slice(0, -1)
  for (const seg of href.split(/[?#]/)[0].split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(decodeURIComponent(seg))
  }
  return parts.join('/')
}

export function isRelative(href: string): boolean {
  return !!href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('#')
}

const plain = make()
let withMath: ReturnType<typeof make> | null = null
let loading: Promise<void> | null = null
const waiters = new Set<() => void>()

export const needsMath = (text: string) => text.includes('$')

// loadMath fetches KaTeX once; onReady runs when it is in.
export function loadMath(onReady: () => void): void {
  if (withMath) return
  waiters.add(onReady)
  if (loading) return
  loading = Promise.all([import('@vscode/markdown-it-katex'), import('katex'), import('katex/dist/katex.min.css')]).then(
    ([plugin, katex]) => {
      // The plugin is CommonJS: the browser build wraps it one level deeper
      // than Node does (seen in Chrome: "e.apply is not a function").
      type Plugin = typeof plugin.default
      const wrapped = plugin.default as Plugin | { default: Plugin }
      const use = typeof wrapped === 'function' ? wrapped : wrapped.default
      const md = make()
      md.use(use, { katex: katex.default, throwOnError: false })
      withMath = md
      waiters.forEach((f) => f())
      waiters.clear()
    },
  )
}

// render returns HTML, with math when KaTeX is loaded and the text has some.
export function render(text: string, opts: RenderOptions = {}): string {
  const md = needsMath(text) && withMath ? withMath : plain
  return md.render(text, opts)
}

export const mathReady = () => !!withMath

// Syntax colours. The names a fence may use for each language syntax.ts
// knows; any other block stays plain.
const langs: Record<string, string> = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  ts: 'ts', typescript: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  py: 'py', python: 'py', go: 'go', golang: 'go',
  json: 'json', jsonc: 'json', css: 'css', html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  yaml: 'yaml', yml: 'yaml',
}
const langOf = (info: string) => langs[info.trim().split(/\s+/)[0]?.toLowerCase() ?? '']
let syntax: typeof import('./syntax') | null = null
const loaded = new Set<string>()
const loadingLang = new Map<string, Promise<void>>()

function highlightCode(code: string, info: string): string {
  const l = langOf(info)
  return l && syntax && loaded.has(l) ? syntax.highlight(code, l) : ''
}

// codeLangs is the known languages a text's fences name and that are not
// loaded yet.
export function codeLangs(text: string): string[] {
  if (!text.includes('```') && !text.includes('~~~')) return []
  const out = new Set<string>()
  for (const m of text.matchAll(/^[ \t]*(?:```|~~~)[ \t]*([\w#+.-]+)/gm)) {
    const l = langOf(m[1])
    if (l && !loaded.has(l)) out.add(l)
  }
  return [...out]
}

// loadLangs fetches those languages' parsers; onReady runs once they are in.
export function loadLangs(list: string[], onReady: () => void): void {
  Promise.all(
    list.map((l) => {
      let p = loadingLang.get(l)
      if (!p) {
        p = import('./syntax').then(async (m) => {
          syntax = m
          await m.load(l)
          loaded.add(l)
        })
        loadingLang.set(l, p)
      }
      return p
    }),
  ).then(onReady, () => {})
}
