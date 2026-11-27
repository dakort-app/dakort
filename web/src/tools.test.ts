import { describe, expect, it } from 'vitest'
import type { Part } from './rows'
import { editChange, lineDiff, readableError, segments, summary, toolHead } from './tools'
import type { Block } from './types'

const use = (name: string, input: object): Block => ({ type: 'tool_use', name, input })
const ok = (text: string): Block => ({ type: 'tool_result', text })
const tool = (b: Block, result?: Block): Part => ({ kind: 'tool', use: b, result })

describe('a tool call on one line', () => {
  it('names the file, not its path, with the path as the tip', () => {
    expect(toolHead(use('Edit', { file_path: 'C:\\x\\main.tex' }))).toEqual({ verb: 'Edit', target: 'main.tex', mono: true, tip: 'C:\\x\\main.tex' })
    expect(toolHead(use('Read', { file_path: '/a/b/App.tsx' })).target).toBe('App.tsx')
  })
  it("uses Claude's words for a command, else words made from it, never the command", () => {
    expect(toolHead(use('Bash', { command: 'npm  test\n -- --run', description: 'Run the tests' }))).toMatchObject({ verb: 'Run the tests', target: '', tip: '' })
    expect(toolHead(use('Bash', { command: 'cd /x && go test ./...' }))).toMatchObject({ verb: 'Run Go tests', target: '' })
    expect(toolHead(use('Bash', { command: 'frobnicate' })).verb).toBe('Run a command')
    expect(toolHead(use('Agent', { description: 'Review the diff', prompt: 'long' }))).toMatchObject({ verb: 'Review the diff', target: '' })
    expect(toolHead(use('Grep', { pattern: 'a.*b' }))).toMatchObject({ verb: 'Search the code', target: '' })
  })
  it('falls back to the tool name in words, its input left for the open row', () => {
    expect(toolHead(use('Mystery', { n: 1 }))).toMatchObject({ verb: 'Mystery', target: '' })
    expect(toolHead(use('mcp__notes__find_page', { q: 'a' }))).toMatchObject({ verb: 'Find page', target: '', tip: 'notes' })
    expect(toolHead(use('ToolSearch', { query: 'select:x', description: 'Load the browser tools' })).verb).toBe('Load the browser tools')
  })
})

describe('an edit as a diff', () => {
  it('keeps the lines both sides share and counts the rest', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nB\nB2\nc\n')
    expect(d.map((l) => l.op + l.text)).toEqual([' a', '-b', '+B', '+B2', ' c'])
    const ch = editChange(use('Edit', { file_path: '/p/x.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nB2\nc' }))!
    expect([ch.add, ch.del, ch.path]).toEqual([2, 1, '/p/x.ts'])
  })
  it('finds lines that stayed inside a changed stretch', () => {
    expect(lineDiff('x\nkeep\ny', 'X\nkeep\nY').map((l) => l.op + l.text)).toEqual(['-x', '+X', ' keep', '-y', '+Y'])
  })
  it('counts a write as all added, and each edit of a MultiEdit', () => {
    expect(editChange(use('Write', { file_path: 'n.ts', content: 'a\nb\n' }))).toMatchObject({ add: 2, del: 0 })
    const m = editChange(use('MultiEdit', { file_path: 'm.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] }))!
    expect([m.hunks.length, m.add, m.del]).toEqual([2, 1, 2])
    expect(editChange(use('Read', { file_path: 'r.ts' }))).toBeUndefined()
  })
})

describe('runs of tool calls', () => {
  const t = (n: string) => tool(use('Read', { file_path: n }), ok('x'))
  const text = (s: string): Part => ({ kind: 'text', text: s })
  const think: Part = { kind: 'thinking', text: '' }
  it('folds three or more calls in a row, with the thinking between them, and leaves shorter runs', () => {
    const parts = [text('a'), t('1'), think, t('2'), t('2b'), think, text('b'), t('3'), t('4'), text('c')]
    expect(segments(parts).map((s) => (s.kind === 'tools' ? `run${s.parts.length}@${s.at}` : s.part.kind + '@' + s.at))).toEqual([
      'text@0',
      'run4@1',
      'thinking@5',
      'text@6',
      'tool@7',
      'tool@8',
      'text@9',
    ])
  })
  it('sums the steps, the files changed, the lines and the failures', () => {
    const parts = [
      tool(use('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' }), ok('')),
      tool(use('Edit', { file_path: 'a', old_string: 'p', new_string: 'q\nr' }), ok('')),
      tool(use('Bash', { command: 'false' }), { ...ok('no'), isError: true }),
      tool(use('Read', { file_path: 'b' })),
    ]
    expect(summary(parts)).toMatchObject({ steps: 4, files: 1, add: 3, del: 2, failed: 1, running: 1, label: 'Read 1 file · edited 1 file · ran 1 command' })
    expect(summary([tool(use('Glob', {})), tool(use('Mystery', {}))]).label).toBe('Ran 1 search · 1 other step')
  })
})

describe('an API error in words', () => {
  it('says what went wrong and keeps the original', () => {
    const raw = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    expect(readableError(raw)).toEqual({ title: 'The API is overloaded', text: 'Try again in a moment.', raw })
    expect(readableError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}').text).toBe('Prompt is too long.')
  })
  it('leaves plain words alone', () => {
    expect(readableError('Failed to authenticate: run claude')).toEqual({ text: 'Failed to authenticate: run claude' })
    expect(readableError('a {broken')).toEqual({ text: 'a {broken' })
  })
})
