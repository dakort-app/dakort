import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting, type LanguageSupport } from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { isDark, onTheme } from './theme'

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

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--mono)' },
  '.cm-gutters': { background: 'var(--side)', borderRight: '1px solid var(--line)', color: 'var(--faint)' },
})

// Syntax colours follow light or dark (theme.ts): One Dark's colours only
// (the background stays the app's), and CodeMirror told it is dark so
// selection, the active line and the search box follow.
const colours = (dark: boolean): Extension =>
  dark ? [syntaxHighlighting(oneDarkHighlightStyle), EditorView.theme({}, { dark: true })] : syntaxHighlighting(defaultHighlightStyle, { fallback: true })

type Props = {
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

export function CodeView({ path, text, jump, visible = true, onLineClick, editing = false, onEdit, onSave, doc, startLine, pos }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const lang = useRef(new Compartment())
  const scheme = useRef(new Compartment())
  const mode = useRef(new Compartment())
  const clickRef = useRef(onLineClick)
  clickRef.current = onLineClick
  const editRef = useRef(onEdit)
  editRef.current = onEdit
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const outside = useRef(false) // a change from the text prop, not typing

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: text,
        extensions: [
          mode.current.of(lock(editing)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !outside.current) editRef.current?.()
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
          scheme.current.of(colours(isDark())),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of(searchKeymap),
          coarse ? EditorView.lineWrapping : [],
          lang.current.of([]),
          theme,
        ],
      }),
    })
    view.current = v
    if (doc) doc.current = () => v.state.doc.toString()
    if (pos) pos.current = () => lineAtTop(v)
    if (startLine) {
      const line = v.state.doc.line(Math.min(Math.max(startLine, 1), v.state.doc.lines))
      v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) })
    }
    let dead = false
    languages[extOf(path)]?.().then((ext) => {
      if (!dead) v.dispatch({ effects: lang.current.reconfigure(ext) })
    })
    const offTheme = onTheme(() => v.dispatch({ effects: scheme.current.reconfigure(colours(isDark())) }))
    return () => {
      dead = true
      offTheme()
      v.destroy()
      view.current = null
      if (doc) doc.current = null
      if (pos) pos.current = null
    }
  }, [path])

  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({ effects: mode.current.reconfigure(lock(editing)) })
    if (editing) v.focus()
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
  }, [text])

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
      title={onLineClick ? 'Click a line number to show it in the PDF' : undefined}
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
