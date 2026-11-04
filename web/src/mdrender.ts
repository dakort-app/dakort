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
  return md
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
