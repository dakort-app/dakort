import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type LanguageSupport } from '@codemirror/language'
import { Compartment, EditorState, RangeSetBuilder, countColumn, type Extension } from '@codemirror/state'
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, highlightActiveLine, keymap, lineNumbers, type DecorationSet, type Panel, type ViewUpdate } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { isDark, onTheme } from './theme'
import { iconHTML } from './iconpaths'
import './FindBar.css'
import './CodeView.css'
import { toolClass } from '@/lib/tool'

// The code view (CodeMirror 6: Monaco is poor on touch), read-only unless
// editing. Languages load by file extension the first time they are needed.

const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

type Loader = () => Promise<LanguageSupport | Extension>

const languages: Record<string, Loader> = {
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  tex: () => import('@codemirror/legacy-modes/mode/stex').then((m) => StreamLanguage.define(m.stex)),
  sty: () => import('@codemirror/legacy-modes/mode/stex').then((m) => StreamLanguage.define(m.stex)),
  cls: () => import('@codemirror/legacy-modes/mode/stex').then((m) => StreamLanguage.define(m.stex)),
  bib: () => import('@codemirror/legacy-modes/mode/stex').then((m) => StreamLanguage.define(m.stex)),
  sh: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  bash: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
  ps1: () => import('@codemirror/legacy-modes/mode/powershell').then((m) => StreamLanguage.define(m.powerShell)),
}

const extOf = (path: string) => (path.split('.').pop() ?? '').toLowerCase()

// One look for both themes, from the app's tokens (styles.css): the
// colours are CSS variables, so a theme switch needs no reconfigure. Every
// syntax colour reads at 4.5:1 or more on the panel and on the active line.
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--t-code)', color: 'var(--text)', backgroundColor: 'var(--panel)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.25rem' },
  // A wrapped line breaks a long name where it reaches the edge, not by
  // moving it whole to the next row and leaving a row of indent behind.
  '.cm-lineWrapping': { overflowWrap: 'anywhere', wordBreak: 'normal' },
  '.cm-content': { caretColor: 'var(--cobalt)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cobalt)' },
  // The line numbers on the panel with space after them, no band or rule:
  // their left edge on the file bar's text edge, the code 12 px clear.
  '.cm-gutters': { background: 'var(--panel)', border: 'none', color: 'var(--faint)', fontVariantNumeric: 'tabular-nums', paddingLeft: 'var(--sp-2)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--sp-1)' },
  // 4 px after the number and 8 here: the code 12 px from its number.
  '.cm-line': { paddingLeft: 'var(--sp-2)' },
  // The active line: where the cursor is, only while the editor has the
  // focus (a file that just opened has no band on line 1; a read-only view
  // never takes the focus).
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--raised)' },
  '&.cm-focused .cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--text-2)' },
  // --code-sel and --code-mark (styles.css): the selection and the
  // highlighter, a little paler in the dark theme so comments stay 4.5:1.
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--code-sel, var(--accent-soft))',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-sel, var(--accent-soft))' },
  '.cm-searchMatch': { backgroundColor: 'var(--code-mark, var(--signature-soft))', boxShadow: 'inset 0 -2px 0 var(--signature)' },
  // The match Find is on: the full highlighter (60% in dark, --code-cur in
  // styles.css) with a hairline ring, its text in the highlighter's ink
  // (6:1 or more), apart from the pale wash of the other matches.
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--code-cur, var(--signature))',
    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--on-signature) 50%, transparent)',
  },
  '.cm-searchMatch-selected, .cm-searchMatch-selected *': { color: 'var(--on-signature)' },
  // The find panel (findPanel below) is the PDF's find bar (.pdf-find).
  '.cm-panels': { backgroundColor: 'transparent', color: 'var(--text)', fontFamily: 'var(--font-sans)' },
  '.cm-panels-top': { borderBottom: 0 },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', border: '1px solid var(--line)', color: 'var(--text)' },
})

// Find in a code file (the header's Find, or Ctrl+F): the same bar as a
// PDF's or a Word file's (FindBar.tsx, .pdf-find), on CodeMirror's search
// state: the box, Aa (match case), ab (whole words), .* (a regular
// expression, with a mouse), the count, up, down and close. Enter finds
// down, Shift+Enter up, Escape closes.
const MAX_COUNT = 9999
function findPanel(view: EditorView): Panel {
  const dom = document.createElement('form')
  dom.className = 'pdf-find code-find'
  const field = document.createElement('input')
  field.className =
    'filter h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs pointer-coarse:h-11 pointer-coarse:text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring/50 dark:bg-input/30'
  field.placeholder = 'Find in file'
  field.setAttribute('aria-label', 'Find in file')
  field.setAttribute('main-field', 'true') // what openSearchPanel focuses
  const btn = (label: string, tip: string, inner: string, cls = '', key = '') => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = toolClass({ className: cls })
    b.setAttribute('aria-label', label)
    b.dataset.tip = tip
    if (key) b.dataset.tipKey = key
    b.innerHTML = inner
    return b
  }
  const caseB = btn('Match case', 'Match case', 'Aa', 'find-opt', 'Alt+C')
  const wordB = btn('Whole words', 'Whole words only', 'ab', 'find-opt word', 'Alt+W')
  const reB = btn('Regular expression', 'A regular expression', '.*', 'find-opt re', 'Alt+R')
  const count = document.createElement('span')
  count.className = 'find-count'
  count.setAttribute('aria-live', 'polite')
  const up = btn('Previous match', 'Find upward', iconHTML('chevron-up'), 'bare', 'Shift+Enter')
  const down = btn('Next match', 'Find downward', iconHTML('chevron-down'), 'bare', 'Enter')
  const close = btn('Close find', 'Close', iconHTML('x'), 'bare', 'Esc')
  dom.append(field, caseB, wordB, reB, count, up, down, close)

  const query = () => getSearchQuery(view.state)
  const set = (o: Partial<{ search: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>) => {
    const q = query()
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: q.search, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp, ...o })) })
  }
  const show = () => {
    const q = query()
    if (field.value !== q.search) field.value = q.search
    for (const [b, on] of [
      [caseB, q.caseSensitive],
      [wordB, q.wholeWord],
      [reB, q.regexp],
    ] as const) {
      b.classList.toggle('on', on)
      b.setAttribute('aria-pressed', String(on))
    }
    up.disabled = down.disabled = true // until there is a match to go to
    if (!q.search || !q.valid) return void (count.textContent = q.search && !q.valid ? 'not valid' : '')
    const sel = view.state.selection.main
    let n = 0
    let cur = 0
    const c = q.getCursor(view.state)
    for (let r = c.next(); !r.done && n <= MAX_COUNT; r = c.next()) {
      n++
      if (r.value.from === sel.from && r.value.to === sel.to) cur = n
    }
    count.textContent = !n ? 'No matches' : n > MAX_COUNT ? `${MAX_COUNT}+` : cur ? `${cur} / ${n}` : `${n} found`
    up.disabled = down.disabled = !n
  }
  field.addEventListener('input', () => set({ search: field.value }))
  field.addEventListener('keydown', (e) => {
    // By the key's place, not its character: ⌥C on a Mac types ç.
    const k = /^Key[CWR]$/.test(e.code) ? e.code.slice(3).toLowerCase() : ''
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSearchPanel(view)
      view.focus()
    } else if (e.altKey && (k === 'c' || k === 'w' || k === 'r')) {
      e.preventDefault()
      const q = query()
      set(k === 'c' ? { caseSensitive: !q.caseSensitive } : k === 'w' ? { wholeWord: !q.wholeWord } : { regexp: !q.regexp })
    }
  })
  dom.addEventListener('submit', (e) => e.preventDefault())
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    ;(e.shiftKey ? findPrevious : findNext)(view)
  })
  caseB.onclick = () => set({ caseSensitive: !query().caseSensitive })
  wordB.onclick = () => set({ wholeWord: !query().wholeWord })
  reB.onclick = () => set({ regexp: !query().regexp })
  up.onclick = () => findPrevious(view)
  down.onclick = () => findNext(view)
  close.onclick = () => {
    closeSearchPanel(view)
    view.focus()
  }
  show()
  return {
    dom,
    top: true,
    mount: () => field.select(),
    update: (u) => {
      if (u.docChanged || u.selectionSet || getSearchQuery(u.state) !== getSearchQuery(u.startState)) show()
    },
  }
}

const colours = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self, t.null, t.bool, t.atom], color: 'var(--syn-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape, t.character, t.url], color: 'var(--syn-str)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.annotation, t.standard(t.name)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.propertyName, t.attributeName, t.labelName, t.macroName], color: 'var(--syn-fn)' },
  { tag: [t.number, t.integer, t.float, t.unit, t.color, t.constant(t.name)], color: 'var(--syn-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: t.heading, color: 'var(--syn-kw)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--syn-fn)', textDecoration: 'underline' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--err)' },
])

// CodeMirror told whether the page is dark, for the parts it draws itself
// (its own defaults under the theme above).
const scheme = (dark: boolean): Extension => EditorView.theme({}, { dark })

// On a phone long lines wrap. A wrapped line's continuation starts two
// columns in from the line's own indent, so it reads as the same line and
// not as a new one starting at the gutter.
const hangs = new Map<number, Decoration>()
const hang = (n: number) => {
  let d = hangs.get(n)
  if (!d) hangs.set(n, (d = Decoration.line({ attributes: { style: `padding-left: calc(${n}ch + var(--sp-2)); text-indent: -${n}ch` } })))
  return d
}
function hanging(v: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  for (const { from, to } of v.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = v.state.doc.lineAt(pos)
      b.add(line.from, line.from, hang(countColumn(/^[ \t]*/.exec(line.text)![0], v.state.tabSize) + 2))
      pos = line.to + 1
    }
  }
  return b.finish()
}
const NARROW = 640 // px: under this a pane wraps long lines
const wrapping = (on: boolean): Extension => (on ? [EditorView.lineWrapping, hangingIndent, breakAfterDots] : [])

// A wrapped line may break after a dot ("dataset." / "theme"): a <wbr>
// there, which adds nothing to the text. Without one a long name has no
// break inside it, so the browser broke at the indent instead, leaving a
// row of indent alone, and then cut the name anywhere.
class Wbr extends WidgetType {
  toDOM() {
    return document.createElement('wbr')
  }
  eq() {
    return true
  }
}
const wbr = Decoration.widget({ widget: new Wbr(), side: 1 })
const dots = new MatchDecorator({ regexp: /\.(?=\w)/g, decorate: (add, _from, to) => add(to, to, wbr) })
const breakAfterDots = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(v: EditorView) {
      this.decorations = dots.createDeco(v)
    }
    update(u: ViewUpdate) {
      this.decorations = dots.updateDeco(u, this.decorations)
    }
  },
  { decorations: (p) => p.decorations },
)
const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(v: EditorView) {
      this.decorations = hanging(v)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = hanging(u.view)
    }
  },
  { decorations: (p) => p.decorations },
)

type Props = {
  // Bumped to put the text back even when it is the same string (Revert:
  // the file on disk is unchanged, the typing over it must go).
  revision?: number
  path: string
  text: string
  jump?: { line?: number; n: number } // scroll to and mark this line
  visible?: boolean // a hidden tab cannot scroll; the jump waits for this
  onLineClick?: (line: number) => void // a click on a line number
  // Editing: typing changes the text, onEdit is told of each change (not
  // of a new text prop), Ctrl+S or Cmd+S calls onSave, and doc reads the
  // text out.
  editing?: boolean
  onEdit?: () => void
  onSave?: () => void
  doc?: { current: (() => string) | null }
  // Where the reader was in another view of the same file (FileView's
  // Markdown preview): the line to open at, and a way to ask which line
  // is at the top, or under the cursor when that is on screen.
  startLine?: number
  pos?: { current: (() => number) | null }
  find?: { current: (() => void) | null } // opens the find panel, or closes it
  onFind?: (open: boolean) => void // the find panel opened or closed
}

// The line the reader is at: the cursor's, when it is on screen (where
// they were just typing), else the one at the top of the view.
function lineAtTop(v: EditorView): number {
  const box = v.scrollDOM.getBoundingClientRect()
  const head = v.state.selection.main.head
  const c = v.coordsAtPos(head)
  if (c && c.top >= box.top && c.bottom <= box.bottom) return v.state.doc.lineAt(head).number
  // A line mostly scrolled past (the few pixels the editor leaves above a
  // line it opened at) is not the one the reader sees first.
  const edge = box.top - v.documentTop
  const block = v.lineBlockAtHeight(edge)
  const n = v.state.doc.lineAt(block.from).number
  return block.bottom - edge < block.height / 2 ? Math.min(n + 1, v.state.doc.lines) : n
}

const lock = (editing: boolean): Extension =>
  editing ? [history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab])] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]

export function CodeView({ path, text, revision = 0, jump, visible = true, onLineClick, editing = false, onEdit, onSave, doc, startLine, pos, find, onFind }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const dark = useRef(new Compartment())
  const mode = useRef(new Compartment())
  const clickRef = useRef(onLineClick)
  clickRef.current = onLineClick
  const editRef = useRef(onEdit)
  editRef.current = onEdit
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const outside = useRef(false) // a change from the text prop, not typing
  const findRef = useRef(onFind)
  findRef.current = onFind
  const wrap = useRef(new Compartment())

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          mode.current.of(lock(editing)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !outside.current) editRef.current?.()
            const open = searchPanelOpen(u.state)
            if (open !== searchPanelOpen(u.startState)) findRef.current?.(open)
          }),
          lineNumbers({
            domEventHandlers: {
              click: (v, block) => {
                if (!clickRef.current) return false
                clickRef.current(v.state.doc.lineAt(block.from).number)
                return true
              },
            },
          }),
          highlightActiveLine(),
          syntaxHighlighting(colours),
          dark.current.of(scheme(isDark())),
          search({ top: true, createPanel: findPanel }),
          highlightSelectionMatches(),
          keymap.of(searchKeymap),
          wrap.current.of(wrapping(coarse)),
          lang.current.of([]),
          theme,
        ],
      }),
    })
    view.current = v
    if (doc) doc.current = () => v.state.doc.toString()
    if (pos) pos.current = () => lineAtTop(v)
    if (find) find.current = () => (searchPanelOpen(v.state) ? closeSearchPanel(v) : openSearchPanel(v))
    // Long lines wrap on a phone, and in a pane too narrow to show a line
    // of code (a split on a laptop), where they were cut at its edge.
    let wrapped = coarse
    const ro = new ResizeObserver(() => {
      const w = v.dom.clientWidth
      const want = coarse || (w > 0 && w < NARROW)
      if (want !== wrapped) v.dispatch({ effects: wrap.current.reconfigure(wrapping((wrapped = want))) })
    })
    ro.observe(v.dom)
    if (startLine) {
      const line = v.state.doc.line(Math.min(Math.max(startLine, 1), v.state.doc.lines))
      v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) })
    }
    let dead = false
    languages[extOf(path)]?.().then((ext) => {
      if (!dead) v.dispatch({ effects: lang.current.reconfigure(ext) })
    })
    const offTheme = onTheme(() => v.dispatch({ effects: dark.current.reconfigure(scheme(isDark())) }))
    return () => {
      dead = true
      ro.disconnect()
      if (searchPanelOpen(v.state)) findRef.current?.(false)
      offTheme()
      v.destroy()
      view.current = null
      if (doc) doc.current = null
      if (pos) pos.current = null
      if (find) find.current = null
    }
  }, [path])

  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({ effects: mode.current.reconfigure(lock(editing)) })
    // On a phone Edit was just tapped: the keyboard comes up. A laptop's
    // file is editable from the start and takes the focus on a click, so
    // a file that opens shows no cursor band on line 1.
    if (editing && coarse) v.focus()
  }, [editing])

  // A refreshed file replaces the text and keeps the reader where they were.
  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === text) return
    const top = v.scrollDOM.scrollTop
    outside.current = true
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
    outside.current = false
    v.scrollDOM.scrollTop = top
  }, [text, revision])

  // Jump to a line (SyncTeX from the PDF): select it, so the active-line
  // highlight marks it, and centre it, once the tab is on screen.
  const done = useRef(0)
  useEffect(() => {
    const v = view.current
    if (!v || !jump?.line || !visible || done.current === jump.n) return
    done.current = jump.n
    v.requestMeasure() // it may have been hidden until now
    const line = v.state.doc.line(Math.min(Math.max(jump.line, 1), v.state.doc.lines))
    v.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
    const el = host.current!
    el.classList.add('jumped')
    const t = window.setTimeout(() => el.classList.remove('jumped'), 3000)
    return () => clearTimeout(t)
  }, [jump?.n, visible])

  // Back on screen after being hidden: let CodeMirror measure again.
  useEffect(() => {
    if (visible) view.current?.requestMeasure()
  }, [visible])

  return (
    <div
      className={'code-view' + (onLineClick ? ' sync-gutter' : '')}
      ref={host}
      data-tip={onLineClick ? `${coarse ? 'Tap' : 'Click'} a line number to show it in the PDF` : undefined}
      // Ctrl+S or Cmd+S while editing saves, and never the browser's Save Page.
      onKeyDownCapture={(e) => {
        if (!editing || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return
        e.preventDefault()
        e.stopPropagation()
        saveRef.current?.()
      }}
    />
  )
}
