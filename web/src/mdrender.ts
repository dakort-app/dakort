// One Markdown renderer for transcripts and .md files. Raw HTML stays
// escaped: replies and files can quote fetched web pages, and what renders
// here runs with the app's cookie. Math ($...$, $$...$$) goes through
// KaTeX, loaded the first time a text has a dollar sign; the plugin cuts
// math out before Markdown runs, so `a_1` inside it is never italics.

import MarkdownIt from 'markdown-it'

export type RenderOptions = {
  // Rewrites a relative image or link target, for files in a folder.
  resolve?: (href: string, kind: 'image' | 'link') => string
}

function make() {
  const md = new MarkdownIt({ html: false, linkify: true })
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
  // A code block gets a Copy button in its corner, outside the <pre> so a
  // block that scrolls sideways does not take the button with it. Markdown
  // handles the click (the HTML is a string here).
  for (const rule of ['fence', 'code_block'] as const) {
    const plainRule = md.renderer.rules[rule]!
    md.renderer.rules[rule] = (tokens, idx, options, env, self) =>
      `<div class="code-block">${plainRule(tokens, idx, options, env, self)}${copyButton}</div>\n`
  }
  md.core.ruler.push('table_columns', (state) => markColumns(state.tokens))
  // Before linkify (an inline rule here), which would otherwise cut the
  // URL out of the src attribute.
  md.inline.ruler.before('linkify', 'img_tag', imgTagRule)
  return md
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

type Tok = { type: string; content: string; attrJoin(name: string, value: string): void }

function markColumns(tokens: Tok[]) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'table_open') continue
    const cells: { tok: Tok; col: number }[] = []
    const longest: number[] = []
    let col = 0
    let j = i + 1
    for (; j < tokens.length && tokens[j].type !== 'table_close'; j++) {
      const t = tokens[j]
      if (t.type === 'tr_open') col = 0
      if (t.type !== 'th_open' && t.type !== 'td_open') continue
      const len = (tokens[j + 1]?.type === 'inline' ? tokens[j + 1].content : '').replace(/[*_`]/g, '').length
      longest[col] = Math.max(longest[col] ?? 0, len)
      cells.push({ tok: t, col: col++ })
    }
    for (const c of cells) c.tok.attrJoin('class', longest[c.col] <= shortCell ? 'short' : 'long')
    i = j
  }
}

// The icons are icons.tsx's CopyIcon and CheckIcon; CSS shows one.
const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const copyButton =
  '<button type="button" class="code-copy" title="Copy" aria-label="Copy code">' +
  svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>') +
  svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>') +
  '</button>'

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
