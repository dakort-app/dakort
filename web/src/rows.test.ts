import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { answer, group, promptText, toolSummary, type Part } from './rows'
import type { Block, Row } from './types'

let n = 0
const row = (role: Row['role'], blocks: Block[], extra: Partial<Row> = {}): Row => ({
  uuid: 'u' + n++,
  role,
  time: '2026-10-22T10:00:00Z',
  offset: 0,
  end: 0,
  blocks,
  ...extra,
})
const text = (t: string): Block => ({ type: 'text', text: t })

describe('background task news', () => {
  it('is a line of its own, and the wake-up answer a new reply', () => {
    const done = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>\n</task-notification>'
    const tick =
      '<task-notification>\n<task-id>b2</task-id>\n<summary>Monitor event: "ticks"</summary>\n<event>tick 1</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>'
    const items = group([
      row('user', [text('Build it in the background')]),
      row('assistant', [text('Started.')]),
      row('user', [text(done)]),
      row('assistant', [text('The build finished.')]),
      row('user', [text(tick)]),
      row('assistant', [text('Tick 1 printed.')]),
    ])
    expect(items.map((it) => it.kind + ':' + (it.kind === 'notice' ? it.text : ''))).toEqual([
      'prompt:',
      'reply:',
      'notice:Background command "Build" completed (exit code 0)',
      'reply:',
      'notice:Monitor event: "ticks": tick 1',
      'reply:',
    ])
  })
})

describe('copying a reply', () => {
  const t = (s: string): Part => ({ kind: 'text', text: s })
  const tool: Part = { kind: 'tool', use: { type: 'tool_use', name: 'Bash' } }
  it('takes the text after the last tool call', () => {
    expect(answer([t('Checking.'), tool, t('Found it.'), tool, t('## Done\n'), { kind: 'thinking', text: '' }, t('Second part.')])).toBe('## Done\n\nSecond part.')
  })
  it('takes all the text when there were no tools, and nothing when a tool came last', () => {
    expect(answer([t('One.'), t('  '), t('Two.')])).toBe('One.\n\nTwo.')
    expect(answer([t('Running it.'), tool])).toBe('')
  })
})

describe('grouping rows', () => {
  it('shows a slash command as typed and its printout as a card; /compact and /rename stay quiet', () => {
    const cmd = (name: string, args = '') =>
      row('user', [text(`<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`)])
    const items = group([
      row('user', [text('<local-command-caveat>Run directly.</local-command-caveat>')], { meta: true }),
      cmd('/context'),
      row('system', [], { subtype: 'local_command', content: '<local-command-stdout>## Context Usage\n\n| a | b |</local-command-stdout>' }),
      cmd('/goal', 'ship it'),
      cmd('/compact'),
      row('user', [text('<local-command-stdout>Compacted </local-command-stdout>')]),
      cmd('/rename', 'New name'),
      row('system', [], { subtype: 'local_command', content: '<local-command-stdout>Session renamed to: New name</local-command-stdout>' }),
    ])
    expect(items.map((it) => (it.kind === 'notice' ? `${it.tone}:${it.text.split('\n')[0]}` : `${it.kind}:${'text' in it ? it.text : ''}`))).toEqual([
      'prompt:/context',
      'output:## Context Usage',
      'prompt:/goal ship it',
    ])
  })

  it('says how much a compaction saved', () => {
    const notice = (extra: Partial<Row>) => group([row('system', [], { subtype: 'compact_boundary', ...extra })])[0]
    expect(notice({ preTokens: 231_400, postTokens: 18_200 })).toMatchObject({ kind: 'notice', text: 'Conversation compacted, 231k → 18k' })
    expect(notice({ preTokens: 32_000 })).toMatchObject({ text: 'Conversation compacted (was 32k)' })
    expect(notice({})).toMatchObject({ text: 'Conversation compacted' })
  })

  it('makes one reply per turn, with tools paired to their results', () => {
    const items = group([
      row('user', [text('<system-reminder>ctx</system-reminder>'), text('fix the bug')]),
      row('assistant', [{ type: 'thinking', text: '' }], { messageId: 'm1' }),
      row('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'go test ./...' } }], { messageId: 'm1' }),
      row('user', [{ type: 'tool_result', id: 't1', content: [text('ok')] }]),
      row('user', [text('<task-notification>x</task-notification>')], { meta: true }),
      row('assistant', [text('Fixed.')], { messageId: 'm2' }),
      row('user', [text('[Request interrupted by user]')]),
      row('user', [text('thanks'), { type: 'image', asset: 'a.png', mediaType: 'image/png' }]),
    ])
    expect(items.map((i) => i.kind)).toEqual(['prompt', 'reply', 'notice', 'prompt'])
    const [p, r, , p2] = items
    expect(p.kind === 'prompt' && p.text).toBe('fix the bug')
    if (r.kind !== 'reply') throw new Error('not a reply')
    expect(r.parts.map((x) => x.kind)).toEqual(['thinking', 'tool', 'text'])
    const tool = r.parts[1]
    expect(tool.kind === 'tool' && tool.result?.content?.[0].text).toBe('ok')
    expect([r.first, r.last]).toEqual([1, 5])
    expect(p2.kind === 'prompt' && p2.media).toHaveLength(1)
  })

  it('shows compaction, API errors, and hides other system rows and sidechains', () => {
    const items = group([
      row('system', [], { subtype: 'compact_boundary' }),
      row('user', [text('summary...')], { compactSummary: true }),
      row('system', [], { subtype: 'turn_duration' }),
      row('assistant', [text('API Error: 529')], { apiError: true }),
      row('assistant', [text('from a subagent')], { sidechain: true }),
    ])
    expect(items.map((i) => (i.kind === 'notice' ? i.tone : i.kind))).toEqual(['divider', 'divider', 'error'])
  })

  it('matches the server on prompt text', () => {
    expect(promptText(row('user', [text('[Image: source: C:\\a.png]'), text('  look  ')]))).toBe('look')
    expect(promptText(row('user', [text('hi')], { meta: true }))).toBe('')
  })

  it('summarises tool calls in one line', () => {
    expect(toolSummary({ type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\x\\main.tex' } })).toBe('Edit: main.tex')
    expect(toolSummary({ type: 'tool_use', name: 'Bash', input: { command: 'a\n  b' } })).toBe('Bash: a b')
    expect(toolSummary({ type: 'tool_use', name: 'Bash', input: { command: 'cd "C:/x" && git status', description: 'Show working tree status' } })).toBe(
      'Bash: Show working tree status',
    )
    expect(toolSummary({ type: 'tool_use', name: 'Mystery', input: { n: 1 } })).toBe('Mystery')
  })
})

// Real rows, when DAKORT_ROWS names a dump of a session page (see BRIEF,
// piece 5). Not committed: transcripts are private.
const dump = process.env.DAKORT_ROWS
describe.skipIf(!dump)('grouping real rows', () => {
  it('covers every visible row once, in order, with unique keys', () => {
    const rows: Row[] = JSON.parse(readFileSync(dump!, 'utf8')).rows
    const items = group(rows)
    const keys = new Set(items.map((i) => i.key))
    expect(keys.size).toBe(items.length)
    for (let i = 1; i < items.length; i++) expect(items[i].first).toBeGreaterThan(items[i - 1].last)
    let tools = 0
    let paired = 0
    for (const it of items) {
      if (it.kind === 'prompt') expect(it.text.startsWith('<')).toBe(false)
      if (it.kind !== 'reply') continue
      for (const p of it.parts) {
        if (p.kind !== 'tool') continue
        tools++
        if (p.result) paired++
      }
    }
    // Only a call cut off by the end of the page may lack its result.
    expect(tools - paired).toBeLessThanOrEqual(1)
    console.log(`${rows.length} rows, ${items.length} items, ${tools} tool calls`)
  })
})
