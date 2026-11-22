import { expect, test, type Page } from '@playwright/test'
import { closeOpened, openSession, seedTabs, tabsKey, quiet, token, type Session } from './helpers'

test.skip(!token, 'DAKORT_TOKEN not set')
test.afterEach(closeOpened)

// A device from before the rename (2026-11-09) keeps its tabs, drafts and
// theme: index.html copies the made.* keys to dakort.* before the first
// paint, and the old cookie is swapped for the new one by the server.
test('a device from before the rename keeps its settings and stays logged in', async ({ page, context }) => {
  await page.goto('/login?token=' + token)
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('made.theme', 'dark')
    localStorage.setItem('made.draft:new:C:\\madetest\\old', 'half a thought')
  })
  // The cookie as the old server set it, instead of the new one.
  await context.clearCookies()
  const url = new URL(page.url())
  await context.addCookies([{ name: 'made_token', value: token, domain: url.hostname, path: '/', httpOnly: true, sameSite: 'Strict' }])
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => localStorage.getItem('dakort.draft:new:C:\\madetest\\old'))).toBe('half a thought')
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('made.')))).toEqual([])
  const names = (await context.cookies()).map((c) => c.name).sort()
  expect(names).toEqual(['dakort_token'])
  expect((await page.request.get('/api/sessions')).status()).toBe(200)
  await page.evaluate(() => {
    localStorage.removeItem('dakort.theme')
    localStorage.removeItem('dakort.draft:new:C:\\madetest\\old')
  })
})

// There is no folder page: home goes straight to a folder, and opening
// another starts from the folder list atop the explorer (on a phone, in
// its drawer). No top bar, and with the explorer hidden no folder name
// beside the tabs.
test('home opens a folder; the folder list opens another', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  await page.goto('/#/')
  await page.waitForURL(/#\/f\//)
  await page.locator('.transcript [data-anchor]').first().waitFor()
  expect(decodeURIComponent(page.url().split('#/f/')[1])).toBe(s.folder)
  await expect(page.locator('.workspace > .bar')).toHaveCount(0)
  await page.screenshot({ path: `test-results/folders-${info.project.name}.png` })

  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar' }).click() // the drawer
  await page.locator('.folder-list').getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('.sheet')).toContainText('Open project')
  // Filtering keeps the sheet's height: sized by its list, it shrank to the
  // bottom of a phone, under the keyboard.
  const tall = (await page.locator('.sheet').boundingBox())!.height
  await page.getByPlaceholder('Filter recent projects').fill('zzz-no-such-project')
  await expect(page.locator('.sheet')).toContainText('Nothing matches.')
  if (info.project.name !== 'desktop') expect((await page.locator('.sheet').boundingBox())!.height).toBe(tall)
  await page.getByPlaceholder('Filter recent projects').fill('')
  // Browse: each folder with its icon, sortable by name or by last change.
  await page.getByRole('button', { name: 'Browse…' }).click()
  await page.locator('.browse-dir .folder-icon').first().waitFor()
  // Into a folder and up again, by the button beside the path.
  const top = await page.getByPlaceholder('Paste a folder path').inputValue()
  await page.locator('.browse-dir').first().click()
  await expect(page.getByPlaceholder('Paste a folder path')).not.toHaveValue(top)
  await page.getByRole('button', { name: 'Up one folder' }).click()
  await expect(page.getByPlaceholder('Paste a folder path')).toHaveValue(top)
  await page.locator('.browse-dir .folder-icon').first().waitFor()
  await page.getByRole('button', { name: 'Recently changed' }).click()
  await page.screenshot({ path: `test-results/browse-${info.project.name}.png` })
  await page.locator('.sheet').getByRole('button', { name: 'A–Z' }).click() // leave it as found
  // New folder asks for a name where Browse stands (making one is the Go
  // test's; here nothing is made on the real disk).
  await page.getByRole('button', { name: '+ New folder' }).click()
  await expect(page.getByLabel('New folder name')).toBeFocused()
  await expect(page.locator('.new-folder').getByRole('button', { name: 'Create' })).toBeDisabled()
  await page.locator('.new-folder').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.new-folder')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.sheet')).toHaveCount(0)
  if (info.project.name !== 'desktop') {
    // A tap beside the drawer closes it.
    await page.mouse.click(page.viewportSize()!.width - 10, page.viewportSize()!.height / 2)
    await expect(page.locator('.explorer-panel')).toHaveCount(0)
  }
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Hide the sidebar' }).click()
    // Nothing beside the tabs but the sidebar button: no folder name (a
    // tab's own title may well contain it, as one did on 2026-10-29).
    await expect(page.locator('.tabs-row > :not(nav):not(button):not(.dot)')).toHaveCount(0)
    await expect(page.locator('.tabs-row > .dot')).toHaveCount(1) // the stream dot moves here from the sidebar
    await page.screenshot({ path: `test-results/explorer-hidden-${info.project.name}.png` })
    await page.getByRole('button', { name: 'Show the sidebar' }).click() // leave it as found
  }
})

// Double-clicking a tab turns its title into a field with the name in it;
// Escape leaves it as it was (Enter is not pressed: real sessions here;
// the rename itself is tested against the server with a throwaway one).
test('a tab title can be edited in place', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a long press on the phone; same code path')
  const s = await openSession(page, (l) => l[0])
  const tab = page.locator('.tab.active')
  await tab.dblclick()
  const field = page.getByRole('textbox', { name: 'New name' })
  await expect(field).toHaveValue(s.title)
  await page.screenshot({ path: 'test-results/rename-field.png' })
  await field.press('Escape')
  await expect(field).toHaveCount(0)
  await expect(tab).toContainText(s.title.slice(0, 10))
})

// The theme button switches light and dark (light to start; the system's
// setting plays no part) and is remembered on the device.
test('the theme button switches light and dark', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' }) // ignored
  await openSession(page, (l) => l[0])
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar' }).click() // the drawer
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
  expect(await theme()).toBe('light')
  await page.getByRole('button', { name: 'Switch to dark' }).click()
  expect(await theme()).toBe('dark')
  expect(await bg()).toBe('#1f1e1c')
  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  expect(await theme()).toBe('dark') // remembered
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar' }).click()
  await page.getByRole('button', { name: 'Switch to light' }).click()
  expect(await theme()).toBe('light')
})

// On a laptop the editor splits in two (from a contributor's branch): the split
// button opens a new session beside the active tab, a tab's menu moves it
// into the second pane, the bar between them
// drags (clamped to a quarter and three quarters), the split survives a
// reload, a tab's menu moves it back, and closing the split brings its
// tabs home.
test('the tab menu copies the command that resumes the session in a terminal', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the tab menu is for a laptop')
  // What the page puts on the clipboard, without the browser's permission.
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string }
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void (w.copied = t) } })
  })
  const s = await openSession(page, quiet)
  await page.locator(`.tab[data-tab="${s.id}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy resume command' }).click()
  await expect(page.locator('.toast')).toContainText('Copied')
  const text = await page.evaluate(() => (window as unknown as { copied: string }).copied)
  expect(text).toBe(`cd '${s.cwd}'; ${s.provider === 'codex' ? 'codex resume' : 'claude --resume'} ${s.id}`)
})

// Two sessions side by side: a reply streaming in one never shows in the
// other, and a send from a pane goes to that pane's session. The turns are
// played into the page's own event handler and the send is answered here:
// these are real sessions, so nothing reaches a CLI. On a phone the same
// saved split is one pane with both tabs.
test('two sessions side by side keep to themselves', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const all: Session[] = await (await page.request.get('/api/sessions')).json()
  const two = all.filter((x) => x.folder === s.folder && x.provider !== 'codex' && !x.heldBy).slice(0, 2).map((x) => x.id)
  test.skip(two.length < 2, 'needs two sessions in one folder')
  const [a, b] = two
  await seedTabs(page, s.folder!, { ids: [a], active: a, right: { ids: [b], active: b } })
  await page.reload()
  const panes = page.locator('.editor-panel')
  if (info.project.name !== 'desktop') {
    await expect(panes).toHaveCount(1)
    await expect(page.locator('.pane-splitter')).toHaveCount(0)
    // Both, in the one pane; a session of the folder that is busy while the
    // checks run (the one shipping) may come in as a tab of its own.
    await expect(page.locator(`.tabs .tab[data-tab="${a}"]`)).toHaveCount(1)
    await expect(page.locator(`.tabs .tab[data-tab="${b}"]`)).toHaveCount(1)
    return
  }
  await expect(panes).toHaveCount(2)
  await panes.nth(0).locator('.composer textarea').waitFor()
  await panes.nth(1).locator('.composer textarea').waitFor()

  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  await play({ type: 'turn', session: a, state: 'running' })
  await play({ type: 'delta', session: a, index: 0, kind: 'text', text: 'madetest streaming into A' })
  await expect(panes.nth(0)).toContainText('madetest streaming into A')
  await expect(panes.nth(1)).not.toContainText('madetest streaming into A')
  await play({ type: 'turn', session: b, state: 'running' })
  await play({ type: 'delta', session: b, index: 0, kind: 'text', text: 'madetest streaming into B' })
  await expect(panes.nth(1)).toContainText('madetest streaming into B')
  await expect(panes.nth(0)).not.toContainText('madetest streaming into B')
  await page.screenshot({ path: 'test-results/split-two-sessions.png' })
  await play({ type: 'turn', session: a, state: 'done' })
  await play({ type: 'turn', session: b, state: 'done' })

  // A send from the right pane goes to B.
  const sent: string[] = []
  await page.route('**/api/sessions/*/send', (route) => {
    sent.push(route.request().url().split('/sessions/')[1].split('/')[0])
    return route.fulfill({ status: 500, json: { error: 'madetest: not sent' } })
  })
  const box = panes.nth(1).locator('.composer textarea')
  await box.fill('madetest hello')
  await box.press('Enter')
  await expect.poll(() => sent).toEqual([b])
  await expect(panes.nth(1).locator('.composer .notice.error')).toContainText('madetest: not sent')
  await box.fill('')
  await page.unroute('**/api/sessions/*/send')
})

// Renaming a project from its row (move.go): a double-click (a long
// press on a phone) gives a name box; a refusal says why under the row,
// and a rename takes the page and its tabs to the new path. The server's
// answers are faked: nothing is renamed on the real disk (the Go tests do
// that, in throwaway folders).
test('a project is renamed from its row', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const folder = s.folder!
  const sep = folder.includes('\\') ? '\\' : '/'
  const moved = folder.slice(0, folder.lastIndexOf(sep) + 1) + 'madetest renamed'
  const bodies: Record<string, unknown>[] = []
  let mode: 'refuse' | 'leftover' | 'ok' = 'refuse'
  let stops = 0
  await page.route('**/api/folders/rename', (route) => {
    bodies.push(route.request().postDataJSON())
    if (mode === 'refuse') return route.fulfill({ status: 409, json: { error: 'madetest: something has it open' } })
    if (mode === 'leftover')
      return route.fulfill({
        status: 409,
        json: {
          error: 'something a session here started is still running in the folder. Stop it, then try again.',
          leftovers: [{ session: s.id, title: s.title, pid: 4242, name: 'node.exe', command: 'node playwright test', dir: folder, started: new Date().toISOString() }],
        },
      })
    return route.fulfill({ json: { path: moved } })
  })
  await page.route(`**/api/sessions/${s.id}/leftovers/4242/stop`, (route) => {
    stops++
    mode = 'ok'
    return route.fulfill({ json: {} })
  })
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar' }).click()
  const row = page.locator('.folder-row.on')
  const ask = async () => {
    if (info.project.name === 'desktop') await row.dblclick()
    else await row.dispatchEvent('touchstart').then(() => page.waitForTimeout(700)).then(() => row.dispatchEvent('touchend'))
    await expect(page.getByLabel('New folder name')).toBeFocused()
  }
  await ask()
  await page.getByLabel('New folder name').fill('madetest renamed')
  await page.screenshot({ path: `test-results/rename-project-${info.project.name}.png` })
  await page.getByLabel('New folder name').press('Enter')
  await expect(page.locator('.folder-error')).toContainText('madetest: something has it open')
  expect(bodies[0]).toEqual({ path: folder, name: 'madetest renamed' })
  expect(new URL(page.url()).hash).toBe('#/f/' + encodeURIComponent(folder))

  // Refused by a process a turn left running in the folder: it is named
  // under the row, and its Stop ends it and renames again.
  mode = 'leftover'
  await ask()
  await expect(page.locator('.folder-error')).toHaveCount(0)
  await page.getByLabel('New folder name').fill('madetest renamed')
  await page.getByLabel('New folder name').press('Enter')
  await expect(page.locator('.folder-error .leftover')).toContainText('node.exe')
  await page.screenshot({ path: `test-results/rename-blocked-${info.project.name}.png` })
  await page.locator('.folder-error').getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => stops).toBe(1)
  await page.waitForURL('**/#/f/' + encodeURIComponent(moved))
  expect(bodies.length).toBe(3)
  const keys = await page.evaluate(([a, b]) => [localStorage.getItem(a), localStorage.getItem(b)], [tabsKey(folder), tabsKey(moved)])
  expect(keys[0]).toBeNull()
  expect(JSON.parse(keys[1]!).ids).toContain(s.id)
  await page.unroute('**/api/folders/rename')
  await page.unroute(`**/api/sessions/${s.id}/leftovers/4242/stop`)
  await page.evaluate((key) => localStorage.removeItem(key), tabsKey(moved)) // leave it as found
})

// On a laptop, tabs past an end of the row get an arrow on that side; a
// click brings the next hidden tab fully into view, one tab a click. A
// plain wheel scrolls the row too. (File tabs, so no session is needed.)
test('tabs past the row have arrows, one tab a click', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'a phone swipes the row')
  const s = await openSession(page, (l) => l[0])
  const ids = [s.id, ...Array.from({ length: 15 }, (_, i) => `f:madetest-a-file-with-a-long-name-${i}.md`)]
  await seedTabs(page, s.folder!, { ids, active: ids[0] })
  await page.reload()
  const strip = page.locator('.tabs-row .tabs')
  const left = page.getByRole('button', { name: 'Show the tab before' })
  const right = page.getByRole('button', { name: 'Show the tab after' })
  await expect(right).toBeVisible()
  await expect(left).toBeDisabled() // there, greyed: nothing to the left yet
  // The tab cut off at the right edge, then one click: it is in full view,
  // and the one after it still is not.
  const cut = async () =>
    strip.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return [...el.querySelectorAll<HTMLElement>('[data-tab]')].findIndex((t) => t.getBoundingClientRect().right > r.right + 1)
    })
  const first = await cut()
  await right.click()
  await expect(left).toBeEnabled()
  expect(await cut()).toBe(first + 1)
  // Back: one tab a click, so maybe two (the step right can half hide a
  // second tab on the left), right to the start.
  for (let i = 0; i < 3 && (await left.isEnabled()); i++) {
    await left.click()
    await page.waitForTimeout(150) // its scroll event greys it, or not
  }
  await expect(left).toBeDisabled()
  expect(await strip.evaluate((el) => el.scrollLeft)).toBe(0)
  // The wheel: down moves the row right.
  await strip.hover()
  await page.mouse.wheel(0, 300)
  await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await page.screenshot({ path: 'test-results/tab-arrows.png' })
})

// On a laptop a tab drags to a new place, which survives a reload.
test('tabs reorder by dragging', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'dragging tabs is for a laptop')
  const s = await openSession(page, (l) => l[0])
  const all: Session[] = await (await page.request.get('/api/sessions')).json()
  const two = all.filter((x) => x.folder === s.folder).slice(0, 2).map((x) => x.id)
  test.skip(two.length < 2, 'needs two sessions in one folder')
  await seedTabs(page, s.folder!, { ids: two, active: two[0] })
  await page.reload()
  const tabs = page.locator('.tabs .tab')
  await expect(tabs).toHaveCount(2)
  const first = await tabs.nth(0).textContent()
  // In small steps, as a hand drags, let go in the empty space after the
  // last tab (letting go there once did nothing).
  const a = (await tabs.nth(0).boundingBox())!
  const b = (await tabs.nth(1).boundingBox())!
  await page.mouse.move(a.x + 10, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width + 40, b.y + b.height / 2, { steps: 20 })
  await page.mouse.up()
  await expect(tabs.nth(1)).toHaveText(first!)
  await page.reload()
  await expect(page.locator('.tabs .tab').nth(1)).toHaveText(first!)
})

// The open tabs are the project's: a second browser (its own context, as
// a phone would be) sees the same tabs, and a tab closed there closes
// here a moment later. Before, each browser, and each address a browser
// used, had its own list.
test("tabs are the project's, the same in every browser", async ({ page, browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'one size is enough; the list is the same on a phone')
  const s = await openSession(page, (l) => l[0])
  const all: Session[] = await (await page.request.get('/api/sessions')).json()
  const two = all.filter((x) => x.folder === s.folder).slice(0, 2).map((x) => x.id)
  test.skip(two.length < 2, 'needs two sessions in one folder')
  await seedTabs(page, s.folder!, { ids: two, active: two[0] })
  await page.reload()
  const tabs = page.locator('.tabs .tab')
  await expect(tabs).toHaveCount(2)
  const second = (await tabs.nth(1).textContent())!

  const other = await browser.newContext({ viewport: page.viewportSize() })
  const page2 = await other.newPage()
  await page2.goto('/login?token=' + token)
  await page2.goto('/#/f/' + encodeURIComponent(s.folder!))
  const tabs2 = page2.locator('.tabs .tab')
  await expect(tabs2).toHaveCount(2)
  await expect(tabs2.nth(1)).toHaveText(second)

  // Closed there, gone here.
  await tabs2.nth(1).hover()
  await tabs2.nth(1).getByLabel('Close tab').click()
  await expect(tabs2).toHaveCount(1)
  await expect(tabs).toHaveCount(1)
  await other.close()
})

// A page out of touch (a phone asleep) has a list that may be behind, and
// must not send it up: one that did closed, on every device, the tabs
// another device opened meanwhile. A tab it closes then comes back; one
// opened elsewhere stays.
test('a page out of touch cannot close the tabs opened elsewhere', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'one size is enough')
  const s = await openSession(page, (l) => l[0])
  const all: Session[] = await (await page.request.get('/api/sessions')).json()
  const three = all.filter((x) => x.folder === s.folder).slice(0, 3).map((x) => x.id)
  test.skip(three.length < 3, 'needs three sessions in one folder')
  await seedTabs(page, s.folder!, { ids: three.slice(0, 2), active: three[0] })
  await page.reload()
  const tabs = page.locator('.tabs .tab')
  await expect(tabs).toHaveCount(2)

  // Out of touch: the stream is cut and cannot come back.
  await page.route('**/api/events*', (r) => r.abort())
  await page.evaluate(() => (window as any).dakort.stream.open())
  // Meanwhile another device opens a third tab, and this page closes one.
  await page.request.post('/api/tabs', { data: { folder: s.folder, ids: three } })
  await tabs.nth(1).hover()
  await tabs.nth(1).getByLabel('Close tab').click()
  await expect(tabs).toHaveCount(1)
  await page.waitForTimeout(500)
  const { ids } = await (await page.request.get('/api/tabs?folder=' + encodeURIComponent(s.folder!))).json()
  expect(ids).toEqual(three)

  // Back in touch: the project's list, all three.
  await page.unroute('**/api/events*')
  await expect(tabs).toHaveCount(3, { timeout: 15_000 })
})

// The tab's icon marks finished work in the folder's own sessions only: a
// session finishing in another folder leaves this tab's icon alone, one in
// this folder (not on screen) marks it. Every tab once marked every
// finish, so three tabs on three projects all said so. The title is the
// folder's name alone.
test('the tab icon marks finished work in its own folder only', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  const all: Session[] = await (await page.request.get('/api/sessions')).json()
  const elsewhere = all.find((x) => x.folder && x.folder !== s.folder)
  const here = all.find((x) => x.folder === s.folder && x.id !== s.id)
  test.skip(!elsewhere || !here, 'needs a session in another folder and a second one in this')
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const icon = page.locator('link[rel="icon"]')
  await expect(page).toHaveTitle(/^[^(·]+$/)
  await expect(icon).not.toHaveAttribute('data-state', 'done')
  await play({ type: 'turn', session: elsewhere!.id, state: 'done', result: { ok: true } })
  await page.waitForTimeout(300)
  await expect(icon).not.toHaveAttribute('data-state', 'done')
  await play({ type: 'turn', session: here!.id, state: 'done', result: { ok: true } })
  await expect(icon).toHaveAttribute('data-state', 'done')
  await expect(page).toHaveTitle(/^[^(·]+$/)
})

// Nothing shows under the folder list until a server that leaves updates
// to the person (the test server is not a release build, so it does) hears
// of a newer release (a release event; the snapshot after a reconnect
// too): then the tag and the line to run on the computer, so the phone
// learns of it without a terminal. The build itself is at the foot of the
// Open project sheet and on the PROJECTS header's tooltip, nowhere else.
test('a newer release is announced under the folder list; the build is in the sheet', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  await openSession(page, (l) => l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  await expect(page.locator('.notice.release')).toHaveCount(0)
  await expect(page.locator('.folder-list .fold')).toHaveAttribute('title', /^Dakort \S+$/)
  await page.locator('.folder-list').getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('.sheet .sheet-version')).toHaveText(/^Dakort \S+$/)
  await page.locator('.sheet-back').click({ position: { x: 4, y: 4 } })
  await expect(page.locator('.sheet')).toHaveCount(0)
  await play({ type: 'release', latest: 'v9.9.9' })
  const notice = page.locator('.notice.release')
  await expect(notice).toContainText('v9.9.9 is out')
  await expect(notice).toContainText('dakort update')
})

// The PROJECTS header in a sidebar dragged narrow (issue 1): + and the
// hide button stay inside the sidebar, Other devices and the theme fold
// into a More menu, and the connection dot is off the button row (shown
// only while reconnecting). On a phone the drawer keeps its full row.
test('the projects header fits a narrow sidebar', async ({ page }, info) => {
  await openSession(page, (l) => l[0])
  const head = page.locator('.folder-list .panel-head')
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar' }).click() // the drawer
  await expect(head.locator('.dot.ok')).toBeAttached()
  await expect(head.locator('.dot.ok')).toBeHidden() // connected: quiet
  if (info.project.name !== 'desktop') {
    await expect(head.getByRole('button', { name: 'Other devices' })).toBeVisible()
    await expect(head.getByRole('button', { name: 'More', exact: true })).toHaveCount(0)
    return
  }
  // The default width holds the whole row.
  await expect(head.getByRole('button', { name: 'Other devices' })).toBeVisible()
  await expect(head.getByRole('button', { name: 'More', exact: true })).toHaveCount(0)
  // Dragged as narrow as it goes.
  const bar = (await page.locator('.splitter').boundingBox())!
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 200)
  await page.mouse.down()
  await page.mouse.move(20, bar.y + 200, { steps: 8 })
  await page.mouse.up()
  const panel = (await page.locator('.explorer-panel').boundingBox())!
  expect(panel.width).toBeLessThan(260)
  for (const name of ['Open project', 'Hide the sidebar', 'More']) {
    const b = (await head.getByRole('button', { name }).boundingBox())!
    expect(b.x + b.width, name).toBeLessThanOrEqual(panel.x + panel.width)
  }
  await expect(head.getByRole('button', { name: 'Other devices' })).toHaveCount(0)
  await head.getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.locator('.head-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Other devices', 'Switch to dark'])
  await menu.getByRole('menuitem', { name: 'Switch to dark' }).click()
  await expect(menu).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await head.getByRole('button', { name: 'More', exact: true }).click()
  await menu.getByRole('menuitem', { name: 'Switch to light' }).click()
  await head.getByRole('button', { name: 'More', exact: true }).click()
  await menu.getByRole('menuitem', { name: 'Other devices' }).click()
  await expect(page.locator('.sheet')).toContainText('Other devices')
  // Back to the default width for the checks after this one.
  await page.evaluate(() => localStorage.removeItem('dakort.explorerWidth'))
})

// The Other devices panel (the icon beside the moon): on the computer the
// first opening asks for a password, then it shows the address and a QR
// code with a Change password link; Tailscale off is said in the panel.
// The server's answers are played here, so the check does not depend on
// this machine's Tailscale.
test('the devices panel asks for a password once, then shows the address and a code', async ({ page }, info) => {
  await openSession(page, (l) => l[0])
  const addr = 'http://laptop.example.ts.net:3003/'
  let state = { tailscale: 'up', addrs: [{ url: addr, kind: 'tailnet' }], localUrl: 'http://127.0.0.1:3003/', passwordSet: false, local: true }
  await page.route('**/api/devices', (route) => route.fulfill({ json: state }))
  await page.route('**/api/devices/qr?**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="1"/></svg>' }))
  const chosen: string[] = []
  await page.route('**/api/password', (route) => {
    chosen.push(route.request().postDataJSON().password)
    state = { ...state, passwordSet: true }
    route.fulfill({ json: {} })
  })
  const open = async () => {
    // The drawer, on a phone; it stays open once the sheet closes.
    const show = page.getByRole('button', { name: 'Show the sidebar' })
    if (info.project.name !== 'desktop' && (await show.isVisible())) await show.click()
    await page.getByRole('button', { name: 'Other devices' }).click()
    await expect(page.locator('.sheet')).toContainText('Other devices')
  }
  await open()
  const sheet = page.locator('.sheet')
  await expect(sheet).toContainText('Choose a password')
  await sheet.getByLabel('Password', { exact: true }).fill('correct horse')
  await sheet.getByLabel('The same again').fill('correct horsE')
  await sheet.getByRole('button', { name: 'Set password' }).click()
  await expect(sheet).toContainText('differ')
  await sheet.getByLabel('The same again').fill('correct horse')
  await sheet.getByRole('button', { name: 'Set password' }).click()
  expect(chosen).toEqual(['correct horse'])
  await expect(sheet).toContainText('scan this')
  await expect(sheet.locator('.devices-addr').first()).toHaveText(addr)
  await expect(sheet.locator('.devices-addr').first()).toHaveAttribute('target', '_blank')
  await expect(sheet.locator('img.devices-qr')).toHaveAttribute('src', '/api/devices/qr?url=' + encodeURIComponent(addr))
  await sheet.getByRole('button', { name: 'Change password' }).click()
  await expect(sheet).toContainText('A new password')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet).toContainText('scan this')
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.sheet')).toHaveCount(0)

  // Tailscale off: said in the panel, no address.
  state = { ...state, tailscale: 'down', addrs: [] }
  await open()
  await expect(sheet).toContainText('not running')
  await expect(sheet.locator('.devices-addr')).toHaveCount(0)
})

// Installable: the page names the manifest and the iOS meta, the manifest
// and its icons load without the cookie (a browser fetches the manifest
// without credentials). The API still refuses a request without the
// cookie. A service worker left from an earlier version (it kept copies of
// the app's files, and an iPhone kept a fixed bug) is removed on the visit.
test('the app is installable, and an old service worker is removed', async ({ browser, playwright }, info) => {
  const bare = await playwright.request.newContext({ baseURL: info.project.use.baseURL })
  try {
    const res = await bare.get('/manifest.webmanifest')
    expect(res.status()).toBe(200)
    const m = await res.json()
    expect(m).toMatchObject({ name: 'Dakort', short_name: 'Dakort', start_url: '/', scope: '/', display: 'standalone' })
    expect(m.icons.map((i: { sizes: string; purpose: string }) => i.sizes + ' ' + i.purpose)).toEqual(['192x192 any', '512x512 any', '512x512 maskable'])
    for (const p of [...m.icons.map((i: { src: string }) => i.src), '/apple-touch-icon.png', '/sw.js']) expect((await bare.get(p)).status(), p).toBe(200)
    expect((await bare.get('/api/sessions')).status()).toBe(401)
    expect((await bare.get('/app.js')).status()).toBe(401)
  } finally {
    await bare.dispose()
  }

  const ctx = await browser.newContext({ ...info.project.use, serviceWorkers: 'allow' })
  try {
    const page = await ctx.newPage()
    await openSession(page, quiet)
    await expect(page.locator('head link[rel=manifest]')).toHaveAttribute('href', '/manifest.webmanifest')
    await expect(page.locator('head link[rel=apple-touch-icon]')).toHaveAttribute('href', '/apple-touch-icon.png')
    await expect(page.locator('head meta[name=apple-mobile-web-app-capable]')).toHaveAttribute('content', 'yes')
    await expect(page.locator('head meta[name=viewport]')).toHaveAttribute('content', /viewport-fit=cover/)
    const supported = await page.evaluate(() => 'serviceWorker' in navigator && window.isSecureContext)
    test.skip(!supported, 'no service workers in this browser on this address')
    // A phone's leftover: a worker at /sw.js with a saved copy.
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js')
      await (await caches.open('dakort-v1')).put('/madetest-kept', new Response('old'))
    })
    await page.reload()
    await expect
      .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length + (await caches.keys()).length))
      .toBe(0)
  } finally {
    await ctx.close()
  }
})

// The terminal: the button opens a panel with a shell in the project's
// folder, what is typed runs, + adds a second, a reload draws the first
// one's output again (the shells live in the server), and closing the
// last hides the panel. A phone has no button. Only echo is typed: the
// shell runs in a real project folder.
test('a terminal runs in the project, survives a reload, and closes', async ({ page }, info) => {
  // Hidden to start with, once: a reload keeps what the page chose.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('madetest-term')) return
    sessionStorage.setItem('madetest-term', '1')
    localStorage.removeItem('dakort.termShown')
  })
  const s = await openSession(page, quiet)
  const button = page.getByRole('button', { name: 'Terminal', exact: true })
  if (info.project.name !== 'desktop') return phoneTerminal(page, s.folder!)
  await button.click()
  const panel = page.getByRole('region', { name: 'Terminal' })
  const tabs = panel.locator('.term-tab')
  await expect(tabs).toHaveCount(1)
  const screen = panel.locator('.term-view:visible .xterm-rows')
  await expect(screen).toBeVisible()
  // The typed line shows the words once, its output a second time.
  const seen = async (s: string) => ((await screen.innerText()).match(new RegExp(s, 'g')) ?? []).length
  await expect.poll(async () => (await screen.innerText()).trim().length, { timeout: 20_000 }).toBeGreaterThan(0) // the prompt
  await panel.locator('.term-view:visible').click()
  await page.keyboard.type('echo madetest-one')
  await page.keyboard.press('Enter')
  await expect.poll(() => seen('madetest-one'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  await page.screenshot({ path: 'test-results/terminal.png' })
  // Ctrl+` hides it and shows it again, also with the focus in the shell.
  await page.keyboard.press('Control+Backquote')
  await expect(panel).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Control+Backquote')
  await expect(tabs).toHaveCount(1)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => seen('madetest-one'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await page.screenshot({ path: 'test-results/terminal-dark.png' })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))

  await panel.getByRole('button', { name: 'New terminal' }).click()
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveClass(/active/)

  await page.reload()
  await expect(tabs).toHaveCount(2)
  await tabs.first().click()
  await expect.poll(() => seen('madetest-one'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

  for (let i = 0; i < 2; i++) await tabs.first().getByRole('button', { name: /^Close / }).click()
  await expect(panel).toHaveCount(0)
  expect(await (await page.request.get('/api/terms?folder=' + encodeURIComponent(s.folder!))).json()).toEqual([])
})

// On a phone the terminal takes the screen, with a row of keys: ↑ brings
// back the last line, Ctrl then c drops a typed line (nothing runs), and
// Ctrl lets go after one key. Back leaves the shell running; opened again,
// its output is there.
async function phoneTerminal(page: Page, folder: string) {
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Terminal' })
  await expect(panel).toBeVisible()
  const box = (await panel.boundingBox())!
  expect(box.width).toBe(page.viewportSize()!.width) // the whole screen
  const screen = panel.locator('.term-view:visible .xterm-rows')
  const seen = async (s: string) => ((await screen.innerText()).match(new RegExp(s, 'g')) ?? []).length
  await expect.poll(async () => (await screen.innerText()).trim().length, { timeout: 20_000 }).toBeGreaterThan(0)
  await panel.locator('.term-view:visible').click()
  await page.keyboard.type('echo madetest-two')
  await page.keyboard.press('Enter')
  await expect.poll(() => seen('madetest-two'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  const keys = panel.getByRole('toolbar', { name: 'Keys' })
  await keys.getByRole('button', { name: 'Up' }).click()
  await page.keyboard.press('Enter')
  await expect.poll(() => seen('madetest-two'), { timeout: 20_000 }).toBeGreaterThanOrEqual(4)
  await page.screenshot({ path: 'test-results/terminal-phone.png' })

  await page.keyboard.type('echo madetest-dropped')
  const ctrl = keys.getByRole('button', { name: 'Ctrl' })
  await ctrl.click()
  await expect(ctrl).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.type('c')
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.type('echo madetest-after')
  await page.keyboard.press('Enter')
  await expect.poll(() => seen('madetest-after'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  expect(await seen('madetest-dropped')).toBe(1) // typed, never run

  await panel.getByRole('button', { name: 'Hide the terminal' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect.poll(() => seen('madetest-after'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  for (const t of await (await page.request.get('/api/terms?folder=' + encodeURIComponent(folder))).json()) await page.request.post(`/api/terms/${t.id}/close`, { data: {} })
}
