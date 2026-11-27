// Syntax colours for code blocks in Markdown, loaded the first time a
// block names a language (mdrender.ts), so none of it is in the first
// load. The parsers are the Lezer ones the file viewer's CodeMirror
// already ships, each fetched on its own; the colours are the --syn-*
// tokens (styles.css, .s-*).

import type { Parser } from '@lezer/common'
import { highlightCode, tagHighlighter, tags as t } from '@lezer/highlight'

const classes = tagHighlighter([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.tagName], class: 's-kw' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.attributeValue], class: 's-str' },
  { tag: [t.typeName, t.className, t.namespace, t.attributeName], class: 's-type' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 's-fn' },
  { tag: [t.number, t.bool, t.atom, t.null, t.unit, t.color], class: 's-num' },
  { tag: [t.comment, t.meta], class: 's-com' },
])

const loaders: Record<string, () => Promise<Parser>> = {
  js: () => import('@lezer/javascript').then((m) => m.parser),
  jsx: () => import('@lezer/javascript').then((m) => m.parser.configure({ dialect: 'jsx' })),
  ts: () => import('@lezer/javascript').then((m) => m.parser.configure({ dialect: 'ts' })),
  tsx: () => import('@lezer/javascript').then((m) => m.parser.configure({ dialect: 'jsx ts' })),
  py: () => import('@lezer/python').then((m) => m.parser),
  go: () => import('@lezer/go').then((m) => m.parser),
  json: () => import('@lezer/json').then((m) => m.parser),
  css: () => import('@lezer/css').then((m) => m.parser),
  html: () => import('@lezer/html').then((m) => m.parser),
  yaml: () => import('@lezer/yaml').then((m) => m.parser),
}

const parsers = new Map<string, Parser>()

export async function load(lang: string): Promise<void> {
  if (parsers.has(lang) || !loaders[lang]) return
  parsers.set(lang, await loaders[lang]())
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// highlight is the code as HTML with coloured spans, '' if its language
// is not loaded (Markdown then escapes it as plain text).
export function highlight(code: string, lang: string): string {
  const p = parsers.get(lang)
  if (!p) return ''
  let out = ''
  highlightCode(
    code,
    p.parse(code),
    classes,
    (text, cls) => (out += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text)),
    () => (out += '\n'),
  )
  return out
}
