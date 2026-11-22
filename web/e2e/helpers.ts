// What the browser checks share. The checks are split by area so a change
// runs only its own (scripts/ship.sh picks them): session.spec.ts is the
// transcript and composer, files.spec.ts the explorer and file views,
// shell.spec.ts the folders, tabs, header and devices around them.

import type { Page } from '@playwright/test'

export const token = process.env.DAKORT_TOKEN ?? ''

export type Session = { id: string; folder?: string; cwd?: string; size: number; title: string; heldBy?: number; provider?: string; updated?: string; used?: { model?: string; mode?: string } }

// quiet picks the newest Claude session nothing is writing to: not held by
// a live CLI and no row in the last 10 minutes. The newest session overall
// is often one in use while the checks run (the one shipping, or another
// turn in progress), and a check that reads it twice saw it change between.
export const quiet = (l: Session[]) =>
  l.find((s) => s.provider !== 'codex' && !s.heldBy && Date.now() - Date.parse(s.updated ?? '') > 10 * 60_000) ?? l[0]

// Where the app keeps a folder's tabs (local.ts: a Windows path's case folded).
export const tabsKey = (folder: string) => 'dakort.tabs:' + (/^[a-z]:[\\/]/i.test(folder) ? folder.toLowerCase() : folder)

// seedTabs sets a folder's tabs as a device would have them: the shared
// list on the server (the project's) and this page's view in local storage.
type Pane = { ids: string[]; active: string }
export async function seedTabs(page: Page, folder: string, t: Pane & { right?: Pane }) {
  await page.request.post('/api/tabs', { data: { folder, ids: [...t.ids, ...(t.right?.ids ?? [])] } })
  await page.evaluate(([key, t]) => localStorage.setItem(key, JSON.stringify(t)), [tabsKey(folder), t] as const)
}

// Folders a check opened (not ones already open) go back off the folder
// bar afterwards: each spec file runs closeOpened after each check.
export const opened: string[] = []
export async function closeOpened({ page }: { page: Page }) {
  for (const path of opened.splice(0)) await page.request.post('/api/folders/close', { data: { path } })
}

// openSession logs in, opens the session's folder with that session as
// its only tab, and waits for the transcript.
export async function openSession(page: Page, pick: (s: Session[]) => Session) {
  await page.goto('/login?token=' + token)
  const sessions: Session[] = await (await page.request.get('/api/sessions')).json()
  const folders: { path: string; open?: boolean; missing?: boolean }[] = await (await page.request.get('/api/folders')).json()
  // Only sessions whose folder is there: the test server keeps no record
  // of folders renamed on the live one, so it files their older sessions
  // under the old name, which has no row to open.
  const there = new Set(folders.filter((f) => !f.missing).map((f) => f.path))
  const s = pick(sessions.filter((x) => x.folder && there.has(x.folder)))
  if (!folders.some((f) => f.path === s.folder && f.open)) opened.push(s.folder!)
  await page.request.post('/api/folders/open', { data: { path: s.folder } })
  await seedTabs(page, s.folder!, { ids: [s.id], active: s.id })
  const hash = '#/f/' + encodeURIComponent(s.folder!)
  await page.goto('/' + hash)
  // Home, still mounted while its folder list arrives, may send the page
  // to the folder with the latest activity instead; insist.
  await page.waitForTimeout(400)
  if (new URL(page.url()).hash !== hash) await page.goto('/' + hash)
  await page.locator('.transcript [data-anchor]').first().waitFor()
  return s
}
