import { beforeEach, describe, expect, it } from 'vitest'
import type { Session } from './types'

// local.ts keeps its state in localStorage; a Map stands in for it.
const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  get length() {
    return store.size
  },
  key: (i: number) => [...store.keys()][i] ?? null,
} as Storage

const { closeTab, finishedIn, flat, followMoves, isUnread, lastFolder, loadTabs, merged, movedPath, moveTab, noteProvider, providerOf, reconcile, sameFolder, saveTabs, selectTab, setLastFolder, split, splitBeside, tabsFor, unsplit } = await import('./local')

describe('folder renames', () => {
  beforeEach(() => store.clear())
  const moves = [{ from: 'C:\\w\\proj a', to: 'C:\\w\\proj b' }]

  it('moves the folder and the ones inside it, not a sibling', () => {
    expect(movedPath('c:\\w\\proj a', moves)).toBe('C:\\w\\proj b')
    expect(movedPath('C:\\w\\proj a\\sub', moves)).toBe('C:\\w\\proj b\\sub')
    expect(movedPath('C:\\w\\proj a-x', moves)).toBe('C:\\w\\proj a-x')
    expect(movedPath('C:\\w\\proj a', [...moves, { from: 'C:\\w\\proj b', to: 'C:\\w\\proj c' }])).toBe('C:\\w\\proj c')
  })

  it('carries tabs, a new session draft and the last folder over', () => {
    saveTabs('C:\\w\\proj a', { ids: ['s1'], active: 's1' })
    saveTabs('C:\\w\\proj a-x', { ids: ['s2'], active: 's2' })
    store.set('dakort.draft:new:C:\\w\\proj a', 'half a thought')
    setLastFolder('C:\\w\\proj a')
    followMoves(moves)
    expect(loadTabs('C:\\w\\proj b')).toEqual({ ids: ['s1'], active: 's1' })
    expect(loadTabs('C:\\w\\proj a')).toEqual({ ids: [], active: '' })
    expect(loadTabs('C:\\w\\proj a-x').ids).toEqual(['s2'])
    expect(store.get('dakort.draft:new:C:\\w\\proj b')).toBe('half a thought')
    expect(lastFolder()).toBe('C:\\w\\proj b')
  })
})

const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 10, min)).toISOString()
// seen comes with the list (the server's, every device's); read up to 10:00
// unless said otherwise.
const session = (id: string, updated: string, seen = at(0)) => ({ id, updated, seen }) as Session

describe('tabsFor', () => {
  beforeEach(() => store.clear())

  it('opens a session another device worked in, not one already seen', () => {
    const laptop = session('laptop', at(5))
    const old = session('old', at(2), at(2))
    const t = tabsFor({ ids: ['mine'], active: 'mine' }, [laptop, old, session('mine', at(1))])
    expect(t).toEqual({ ids: ['laptop', 'mine'], active: 'mine' })
  })

  it('puts the newest of several at the front', () => {
    const t = tabsFor({ ids: ['x'], active: 'x' }, [session('b', at(6)), session('a', at(5)), session('x', at(1))])
    expect(t.ids).toEqual(['b', 'a', 'x'])
  })

  it('opens a running session, even one seen', () => {
    const s = session('run', at(3), at(3))
    expect(tabsFor({ ids: [], active: '' }, [s], (id) => id === 'run').ids).toEqual(['run'])
  })

  it('counts a session read on another device as read', () => {
    expect(isUnread(session('s', at(5)))).toBe(true)
    expect(isUnread(session('s', at(5), at(5)))).toBe(false) // the phone read it
    expect(isUnread({ id: 's', updated: at(5) } as Session)).toBe(false) // an older server: no dots
  })

  it('leaves a session read on every device closed', () => {
    const s = session('s', at(5), at(5)) // closing marked it read
    expect(tabsFor({ ids: ['x'], active: 'x' }, [s, session('x', at(1))]).ids).toEqual(['x'])
    // New work, not seen: back.
    const later = session('s', at(6))
    expect(tabsFor({ ids: ['x'], active: 'x' }, [later, session('x', at(1))]).ids).toEqual(['s', 'x'])
  })

  it('keeps a tab whose session is missing from the folder but exists', () => {
    const seen = session('claude', at(3), at(3))
    const t = tabsFor({ ids: ['claude'], active: 'claude' }, [], () => false, (id) => id === 'claude')
    expect(t).toEqual({ ids: ['claude'], active: 'claude' })
    expect(tabsFor({ ids: ['gone'], active: 'gone' }, [seen], () => false, (id) => id === 'claude').ids).toEqual(['claude'])
  })
})

// Split view (from a contributor's branch).
describe('split view', () => {
  beforeEach(() => store.clear())
  const base = { ids: ['a', 'b', 'c'], active: 'b' }

  it('moves a tab into a second pane, focused', () => {
    expect(split(base, 'b')).toEqual({ ids: ['a', 'c'], active: 'c', right: { ids: ['b'], active: 'b' }, focus: 'right' })
  })

  it('opens a new session beside a lone tab', () => {
    expect(split({ ids: ['a'], active: 'a' }, 'a')).toEqual({ ids: ['a'], active: 'a', right: { ids: ['new'], active: 'new' }, focus: 'right' })
    expect(split({ ids: ['new'], active: 'new' }, 'new')).toEqual({ ids: ['new'], active: 'new' })
  })

  it('the split button keeps the tab on screen and opens a new session beside it', () => {
    expect(splitBeside(base)).toEqual({ ...base, right: { ids: ['new'], active: 'new' }, focus: 'right' })
    expect(splitBeside({ ids: ['a', 'new'], active: 'a' })).toMatchObject({ ids: ['a'], active: 'a', right: { ids: ['new'], active: 'new' }, focus: 'right' })
    expect(splitBeside({ ids: ['new'], active: 'new' })).toEqual({ ids: ['new'], active: 'new' })
  })

  it('selects a tab where it is, and opens a new one in the focused pane', () => {
    const t = split(base, 'b') // focus right
    expect(selectTab(t, 'a').active).toBe('a')
    expect(selectTab(t, 'a').focus).toBeUndefined()
    expect(selectTab(t, 'x').right).toEqual({ ids: ['b', 'x'], active: 'x' })
    expect(selectTab({ ...t, focus: undefined }, 'x').ids).toEqual(['a', 'c', 'x'])
  })

  it('closing the last tab of a pane closes the split', () => {
    const t = split(base, 'b')
    expect(closeTab(t, 'b')).toEqual({ ids: ['a', 'c'], active: 'c' })
    // The first pane emptied: the second becomes the only one.
    expect(closeTab(closeTab(t, 'a'), 'c')).toEqual({ ids: ['b'], active: 'b' })
  })

  it('moves a tab across, at a place', () => {
    const t = moveTab(split(base, 'b'), 'a', 1, 0)
    expect(t.right).toEqual({ ids: ['a', 'b'], active: 'a' })
    expect(t.ids).toEqual(['c'])
    expect(moveTab(t, 'b', 0, 0)).toMatchObject({ ids: ['b', 'c'], active: 'b', right: { ids: ['a'], active: 'a' } })
  })

  it("unsplit puts the second pane's tabs back after the first's", () => {
    expect(unsplit({ ...split(base, 'b'), ratio: 0.4 })).toEqual({ ids: ['a', 'c', 'b'], active: 'c', ratio: 0.4 })
  })

  it("a phone sees one list, on the focused pane's tab", () => {
    expect(merged(split(base, 'b'))).toEqual({ ids: ['a', 'c', 'b'], active: 'b' })
  })

  it('tabsFor keeps the split, drops gone tabs and adds new work to the first pane only once', () => {
    const t = { ids: ['x', 'gone'], active: 'x', right: { ids: ['y', 'gone2'], active: 'gone2' }, focus: 'right' as const, ratio: 0.6 }
    const r = tabsFor(t, [session('y', at(7)), session('n', at(6)), session('x', at(1))])
    expect(r).toEqual({ ids: ['n', 'x'], active: 'x', right: { ids: ['y'], active: 'y' }, focus: 'right', ratio: 0.6 })
  })

  it('tabsFor hands the first pane over when its tabs are gone', () => {
    const r = tabsFor({ ids: ['gone'], active: 'gone', right: { ids: ['y'], active: 'y' } }, [session('y', at(1), at(1))])
    expect(r).toEqual({ ids: ['y'], active: 'y' })
  })

  it('a saved split survives a reload, ratio clamped', () => {
    saveTabs('/f', { ...split(base, 'b'), ratio: 0.95 })
    expect(loadTabs('/f')).toEqual({ ids: ['a', 'c'], active: 'c', right: { ids: ['b'], active: 'b' }, focus: 'right', ratio: 0.75 })
  })
})

describe('providerOf', () => {
  it('knows a session just started before the list has it', () => {
    expect(providerOf('new-one')).toBe('claude')
    noteProvider('new-one', 'codex')
    expect(providerOf('new-one')).toBe('codex')
    expect(providerOf('new-one', 'claude')).toBe('claude') // the list wins once it has it
  })
})

describe('folders', () => {
  beforeEach(() => store.clear())

  it('are one folder whatever the case of a Windows path', () => {
    expect(sameFolder('c:\\Users\\A\\jason', 'C:\\Users\\A\\jason')).toBe(true)
    expect(sameFolder('/home/a/X', '/home/a/x')).toBe(false)
  })

  it('keep their tabs under both spellings, and find ones saved before', () => {
    store.set('dakort.tabs:C:\\A\\old', JSON.stringify({ ids: ['o'], active: 'o' }))
    expect(loadTabs('C:\\A\\old').ids).toEqual(['o'])
    saveTabs('c:\\A\\new', { ids: ['n'], active: 'n' })
    expect(loadTabs('C:\\A\\NEW').ids).toEqual(['n'])
  })
})

// The shared list is the project's; this device keeps its view.
describe('reconcile', () => {
  const base = { ids: ['a', 'b'], active: 'b', right: { ids: ['c'], active: 'c' }, focus: 'right' as const, ratio: 0.6 }

  it('does nothing until the server has answered', () => {
    expect(reconcile(base, undefined)).toEqual(base)
  })

  it('drops tabs closed elsewhere, keeping the active one near its place', () => {
    expect(reconcile(base, ['a', 'c'])).toEqual({ ids: ['a'], active: 'a', right: { ids: ['c'], active: 'c' }, focus: 'right', ratio: 0.6 })
  })

  it('brings tabs opened elsewhere into the focused pane, in the shared order', () => {
    expect(reconcile(base, ['d', 'a', 'b', 'c'])).toEqual({ ids: ['a', 'b'], active: 'b', right: { ids: ['d', 'c'], active: 'c' }, focus: 'right', ratio: 0.6 })
    expect(reconcile({ ids: ['b', 'a'], active: 'a' }, ['a', 'b', 'n'])).toEqual({ ids: ['a', 'b', 'n'], active: 'a' })
  })

  it('keeps a new-session tab with a draft, and a session just started here', () => {
    expect(reconcile({ ids: ['new', 'a'], active: 'new' }, ['a'], (id) => id === 'new')).toEqual({ ids: ['a', 'new'], active: 'new' })
  })

  it('closes the split when the second pane is emptied elsewhere', () => {
    expect(reconcile(base, ['a', 'b'])).toEqual({ ids: ['a', 'b'], active: 'b', ratio: 0.6 })
  })

  it('flat is both panes in order, what the server is told', () => {
    expect(flat(base)).toEqual(['a', 'b', 'c'])
    expect(flat({ ids: ['x'], active: 'x' })).toEqual(['x'])
  })
})

describe('finishedIn', () => {
  const sessions = [{ id: 'a', folder: 'C:/w/megi' }, { id: 'b', folder: 'c:/w/MEGI' }, { id: 'c', folder: 'C:/w/dakort' }] as Session[]
  it('counts the folder on screen alone, in either spelling, and all on the home screen', () => {
    expect(finishedIn(['a', 'b', 'c'], sessions, 'C:/w/megi')).toBe(2)
    expect(finishedIn(['a', 'b', 'c'], sessions, 'C:/w/dakort')).toBe(1)
    expect(finishedIn(['a', 'b', 'c'], sessions, 'C:/w/other')).toBe(0)
    expect(finishedIn(['a', 'b', 'c'], sessions, '')).toBe(3)
  })
})

describe('resumeCommand', () => {
  it('goes to the folder, then resumes by id with the session own CLI', async () => {
    const { resumeCommand } = await import('./local')
    expect(resumeCommand({ id: 'abc', provider: 'claude', cwd: 'C:\\w\\proj a' })).toBe("cd 'C:\\w\\proj a'; claude --resume abc")
    expect(resumeCommand({ id: 'def', provider: 'codex', cwd: '/home/sam/x' })).toBe("cd '/home/sam/x'; codex resume def")
    expect(resumeCommand({ id: 'ghi', provider: 'claude', cwd: "C:\\w\\sam's" })).toBe('cd "C:\\w\\sam\'s"; claude --resume ghi')
    expect(resumeCommand({ id: 'jkl', provider: 'claude', cwd: '' })).toBe('claude --resume jkl')
  })
})
