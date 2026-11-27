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

  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click() // the drawer
  await page.locator('.folder-list').getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('.sheet')).toContainText('Open project')
  // Filtering keeps the sheet's height: sized by its list, it shrank to the
  // bottom of a phone, under the keyboard.
  // On a phone the sheet takes its tall size once the filter is tapped.
  await page.getByPlaceholder('Filter recent projects').focus()
  await page.waitForTimeout(300)
  const tall = (await page.locator('.sheet').boundingBox())!.height
  await page.getByPlaceholder('Filter recent projects').fill('zzz-no-such-project')
  await expect(page.locator('.sheet')).toContainText('Nothing matches.')
  if (info.project.name !== 'desktop') expect((await page.locator('.sheet').boundingBox())!.height).toBeCloseTo(tall, 0) // the sheet rises in: a fraction of a pixel
  await page.getByPlaceholder('Filter recent projects').fill('')
  // Browse: each folder with its icon, sortable by name or by last change.
  await page.getByRole('button', { name: 'Browse…' }).click()
  await page.locator('.browse-dir .folder-icon').first().waitFor()
  // Into a folder and up again, by the breadcrumb's step before the last.
  const path = page.locator('.sheet .crumbs')
  const top = (await path.getAttribute('data-path'))!
  await page.locator('.browse-dir').first().click()
  await expect(path).not.toHaveAttribute('data-path', top)
  await path.locator('.crumb').nth(-2).click()
  await expect(path).toHaveAttribute('data-path', top)
  await page.locator('.browse-dir .folder-icon').first().waitFor()
  // Its empty end makes it a field with the path; Escape gives the steps
  // back and leaves the sheet open.
  await path.locator('.crumb-end').click()
  const field = page.locator('.sheet .crumb-edit input')
  await expect(field).toHaveValue(top)
  await expect(field).toBeFocused()
  await field.press('Escape')
  await expect(path).toBeVisible()
  await expect(page.locator('.sheet')).toBeVisible()
  // Sorted from the same small menu as the file explorer's.
  const sort = async (name: string) => {
    await page.locator('.sheet').getByRole('button', { name: 'Sort', exact: true }).click()
    await page.getByRole('menuitemradio', { name }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.locator('.sheet')).toBeVisible() // picking closed the menu only
  }
  await sort('Recent')
  await page.screenshot({ path: `test-results/browse-${info.project.name}.png` })
  await sort('Name') // leave it as found
  // The foot holds only Open as project: the path is in the breadcrumb.
  await expect(page.locator('.sheet .sheet-foot')).toHaveText('Open as project')
  // New folder asks for a name where Browse stands (making one is the Go
  // test's; here nothing is made on the real disk).
  await page.locator('.sheet').getByRole('button', { name: 'New folder', exact: true }).click()
  await expect(page.getByLabel('New folder name')).toBeFocused()
  await expect(page.locator('.new-folder').getByRole('button', { name: 'Create' })).toBeDisabled()
  // The rows of controls stand in from the sheet's sides, and each row's
  // controls are of one height (the breadcrumb, Sort and New folder; the
  // name, Create and Cancel).
  const sheet = (await page.locator('.sheet').boundingBox())!
  for (const row of await page.locator('.sheet > :is(.filter-row, .crumb-row)').all()) {
    const boxes = await row.locator(':scope > :is(button, input, span, div)').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, right: r.right, h: Math.round(r.height) })))
    expect(new Set(boxes.map((b) => b.h)).size, 'one height in a row').toBe(1)
    expect(boxes[0].x - sheet.x, 'room on the left').toBeGreaterThanOrEqual(12)
    expect(sheet.x + sheet.width - boxes.at(-1)!.right, 'room on the right').toBeGreaterThanOrEqual(12)
  }
  await page.locator('.new-folder').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.new-folder')).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('.sheet')).toHaveCount(0)
  if (info.project.name !== 'desktop') {
    // A tap beside the drawer closes it.
    await page.mouse.click(page.viewportSize()!.width - 10, page.viewportSize()!.height / 2)
    await expect(page.locator('.explorer-panel')).toHaveCount(0)
  }
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Hide the sidebar', exact: true }).click()
    // Nothing beside the tabs but the sidebar button: no folder name (a
    // tab's own title may well contain it, as one did on 2026-10-29).
    await expect(page.locator('.tabs-row > :not(nav):not(button):not(.dot)')).toHaveCount(0)
    await expect(page.locator('.tabs-row > .dot')).toHaveCount(1) // the stream dot moves here from the sidebar
    await page.screenshot({ path: `test-results/explorer-hidden-${info.project.name}.png` })
    await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click() // leave it as found
  }
})

// A folder list that will not load leaves the home usable: the failure in
// words with Try again, and Open project, which browses without the list.
test('the home stays usable when the folder list fails', async ({ page }) => {
  let fail = true
  await page.route('**/api/folders', (r) => (fail && r.request().method() === 'GET' ? r.fulfill({ status: 500, contentType: 'text/plain', body: 'madetest: input/output error' }) : r.fallback()))
  await page.goto('/login?token=' + token) // lands on the home, with the list failing
  const problem = page.locator('.home .notice.error')
  await expect(problem).toContainText('Could not list your projects.')
  await expect(problem).toContainText('madetest: input/output error')
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await expect(page.locator('.sheet')).toContainText('Open project')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  fail = false
  await problem.getByRole('button', { name: 'Try again' }).click()
  await expect(problem).toHaveCount(0)
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
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click() // the drawer
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--panel').trim())
  expect(await theme()).toBe('light')
  // The settings menu holds the Dark mode switch (the gear at the tab
  // bar's end on a laptop, Settings at the phone drawer's foot): the
  // setting itself, its state on the control.
  const settings = () =>
    info.project.name === 'desktop'
      ? page.getByRole('button', { name: 'Settings', exact: true }).click()
      : page.locator('.drawer-foot').getByRole('button', { name: 'Settings' }).click()
  const dark = page.getByRole('menuitemcheckbox', { name: 'Dark mode' })
  await settings()
  await dark.click()
  expect(await theme()).toBe('dark')
  expect(await bg()).toBe('#1c1b19')
  await page.keyboard.press('Escape')
  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  expect(await theme()).toBe('dark') // remembered
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  await settings()
  await expect(dark).toHaveAttribute('aria-checked', 'true')
  await dark.click()
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

// The tab menu from the keyboard: Shift+F10 on a tab puts the focus on
// its first row, the arrows, Home and End move, Escape and Tab close it
// and give the focus back to the tab, and the tab's tip is down.
test('the tab menu works from the keyboard', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the tab menu is for a laptop')
  const s = await openSession(page, quiet)
  const tab = page.locator(`.tab[data-tab="${s.id}"]`)
  const menu = page.locator('.tab-menu')
  const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
  await tab.focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  const rows = (await menu.locator('[role="menuitem"]:not(:disabled)').allTextContents()).map((t) => t.trim())
  await expect.poll(focused).toBe(rows[0])
  await expect(page.locator('.tip[data-open]')).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  expect(await focused()).toBe(rows[1])
  await page.keyboard.press('End')
  expect(await focused()).toBe(rows[rows.length - 1])
  await page.keyboard.press('Home')
  expect(await focused()).toBe(rows[0])
  await page.keyboard.press('ArrowUp')
  expect(await focused()).toBe(rows[rows.length - 1])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(tab).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(menu).toHaveCount(0)
  await expect(tab).toBeFocused()
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

// Many open projects, all shown: the list scrolls on its own, so the
// last row can be reached on a phone and the files below keep a share of
// the sidebar. The panel clips, and the list once could not shrink, so
// rows past the bottom were out of reach. The extra folders are faked.
test('a long project list scrolls in the sidebar', async ({ page }, info) => {
  const s = await openSession(page, quiet)
  await page.route('**/api/folders', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const real = await (await r.fetch()).json()
    const fake = Array.from({ length: 20 }, (_, i) => ({ path: s.folder!.slice(0, 3) + 'madetest-many-' + String(i).padStart(2, '0'), open: true, sessions: 1 }))
    return r.fulfill({ json: [...real, ...fake] })
  })
  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  await page.locator('.folder-row.more').click()
  const last = page.locator('.folder-list > .folder-row', { hasText: 'madetest-many-19' })
  await expect(last).toHaveCount(1)
  const fit = await last.evaluate((el) => {
    let box: HTMLElement | null = el.parentElement
    while (box && !(['auto', 'scroll'].includes(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement
    if (!box) return { scrolls: false, bottom: 0, files: 0 }
    box.scrollTop = box.scrollHeight
    const files = document.querySelector('.explorer-panel .explorer')?.getBoundingClientRect().height ?? 0
    return { scrolls: true, bottom: el.getBoundingClientRect().bottom - Math.min(innerHeight, box.getBoundingClientRect().bottom), files }
  })
  await page.screenshot({ path: `test-results/many-projects-${info.project.name}.png` })
  expect(fit.scrolls).toBe(true)
  expect(fit.bottom).toBeLessThanOrEqual(1)
  expect(fit.files).toBeGreaterThan(100)
  await page.unroute('**/api/folders')
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
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  const row = page.locator('.folder-row.on')
  const ask = async () => {
    if (info.project.name === 'desktop') await row.dblclick()
    else {
      // A long press opens the row's menu (its whole path on top); Rename is in it.
      await row.dispatchEvent('touchstart').then(() => page.waitForTimeout(700)).then(() => row.dispatchEvent('touchend'))
      await expect(page.locator('.row-menu .menu-title')).toHaveText(folder)
      await page.locator('.row-menu').getByRole('menuitem', { name: 'Rename' }).click()
    }
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
  // The arrows are the header's icon buttons' size and rounded shape, and
  // every header button is centred in the bar, clear of its bottom line.
  const bar = (await page.locator('.tabs-row').first().boundingBox())!
  const newBtn = (await page.getByRole('button', { name: 'New session' }).first().boundingBox())!
  for (const b of await page.locator('.tabs-row').first().locator('> button:visible').all()) {
    const box = (await b.boundingBox())!
    const name = await b.getAttribute('aria-label')
    expect(Math.round(box.height), `${name} tall`).toBe(Math.round(newBtn.height))
    expect(Math.round(bar.y + bar.height - (box.y + box.height)), `${name} clear of the bottom`).toBeGreaterThanOrEqual(3)
    expect(Math.abs(box.y - bar.y - (bar.y + bar.height - box.y - box.height)), `${name} centred`).toBeLessThanOrEqual(1)
  }
  expect(parseFloat(await right.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(0)
  // The tabs' titles and icons are on the buttons' line: each centre
  // within 1 px of the buttons' centre.
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2
  const line = mid(newBtn)
  const tab = page.locator('.tabs-row .tab').first()
  for (const part of [tab.locator('.ellipsis'), tab.locator('svg, img').first(), page.locator('.tabs-row .tab.active .ellipsis')]) {
    expect(Math.abs(mid((await part.boundingBox())!) - line)).toBeLessThanOrEqual(1)
  }
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
// folder's name, with a dot in front only while the icon says done.
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
  await expect(page).toHaveTitle(/^● [^(·●]+$/)
})

// The tab's icon and title through a whole turn, as a person sees them
// from another browser tab: the inverted tile while it runs, the round
// disc and a dot before the name once it is done and unread, and back to
// the quiet tile and the bare name when its session is looked at.
test('the tab says running, then done, and goes quiet once seen', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const all: Session[] = await (await page.request.get('/api/sessions')).json()
  const other = all.find((x) => x.folder === s.folder && x.id !== s.id)
  test.skip(!other, 'needs a second session in the folder')
  await seedTabs(page, s.folder!, { ids: [s.id, other!.id], active: s.id })
  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const icon = page.locator('link[rel="icon"]')
  const name = (await page.title()).replace(/^● /, '')
  await expect(icon).not.toHaveAttribute('data-state', /run|done/)
  await expect(page).toHaveTitle(name)

  // The session's own tab: its state in the ×'s slot (the project rows'
  // spinner while it runs). Done here is the stream's word only (the
  // session's file did not change), so its unread semibold is not seen.
  const otherTab = page.locator(`.tabs .tab[data-tab="${other!.id}"]`)
  const weight = () => otherTab.locator('.ellipsis').evaluate((el) => Number(getComputedStyle(el).fontWeight))
  await play({ type: 'turn', session: other!.id, state: 'running' })
  await expect(icon).toHaveAttribute('data-state', 'run')
  await expect(page).toHaveTitle(name)
  await expect(otherTab).toHaveAttribute('data-state', 'run')
  // The project rows' spinner, in the ×'s slot of a tab not in use; the
  // agent's mark stays still.
  await expect(otherTab.locator('.tab-x .dot.run')).toBeVisible()
  await expect(otherTab.locator('.tab-x svg')).toBeHidden()
  expect(await otherTab.locator('.agent-icon').evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  // Under the pointer the × takes the slot back (a phone has no pointer).
  if (info.project.name === 'desktop') {
    await otherTab.hover()
    await expect(otherTab.locator('.tab-x svg')).toBeVisible()
    await expect(otherTab.locator('.tab-x .dot')).toBeHidden()
    await page.mouse.move(5, 500)
  }
  const href = await icon.getAttribute('href')
  expect(href).toContain('data:image/svg+xml')

  await play({ type: 'turn', session: other!.id, state: 'done', result: { ok: true } })
  await expect(icon).toHaveAttribute('data-state', 'done')
  await expect(page).toHaveTitle('● ' + name)
  expect(decodeURIComponent((await icon.getAttribute('href'))!)).toContain('<circle')

  await otherTab.click()
  await expect(icon).toHaveAttribute('data-state', 'idle')
  await expect(page).toHaveTitle(name)
  await expect(otherTab).not.toHaveAttribute('data-state', /./)
  expect(await weight()).toBeLessThan(600) // read: the name at its normal weight
})

// Nothing shows under the folder list until a server that leaves updates
// to the person (the test server is not a release build, so it does) hears
// of a newer release (a release event; the snapshot after a reconnect
// too): then the tag and the line to run on the computer, so the phone
// learns of it without a terminal. The build itself is at the foot of the
// Open project sheet and at the end of the settings menu, nowhere else.
test('a newer release is announced under the folder list; the build is in the sheet', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  await openSession(page, (l) => l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  await expect(page.locator('.notice.release')).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.settings-menu')).toContainText(/Dakort \S+$/)
  await page.keyboard.press('Escape')
  await page.locator('.folder-list').getByRole('button', { name: 'Open project' }).click()
  await expect(page.locator('.sheet .sheet-version')).toHaveText(/^Dakort \S+$/)
  await page.locator('.sheet-back').click({ position: { x: 4, y: 4 } })
  await expect(page.locator('.sheet')).toHaveCount(0)
  await play({ type: 'release', latest: 'v9.9.9' })
  const notice = page.locator('.notice.release')
  await expect(notice).toContainText('v9.9.9 is out')
  await expect(notice).toContainText('dakort update')
})

// The Projects header in a sidebar dragged narrow (issue 1): + stays
// inside the sidebar, and the connection dot is off the button row (shown
// only while reconnecting). The hide button is at the tab bar's start, and
// Other devices and the theme are in the settings menu (the gear at the
// tab bar's end; Settings at the phone drawer's foot), so the sidebar
// keeps its height for the files.
test('the projects header fits a narrow sidebar', async ({ page }, info) => {
  await openSession(page, (l) => l[0])
  const head = page.locator('.folder-list .side-head')
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click() // the drawer
  await expect(head.locator('.dot.ok')).toBeAttached()
  await expect(head.locator('.dot.ok')).toBeHidden() // connected: quiet
  await expect(head.getByRole('button', { name: 'Other devices' })).toHaveCount(0)
  await expect(head.getByRole('button', { name: 'More', exact: true })).toHaveCount(0)
  await expect(head.getByRole('button', { name: 'Hide the sidebar', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Other devices' })).toHaveCount(0) // a menu item now
  if (info.project.name !== 'desktop') {
    await page.locator('.drawer-foot').getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('menuitem', { name: 'Other devices' })).toBeVisible()
    return
  }
  await expect(page.locator('.drawer-foot')).toHaveCount(0) // no foot on a laptop
  // Dragged as narrow as it goes.
  const bar = (await page.locator('.splitter').boundingBox())!
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 200)
  await page.mouse.down()
  await page.mouse.move(20, bar.y + 200, { steps: 8 })
  await page.mouse.up()
  const panel = (await page.locator('.explorer-panel').boundingBox())!
  expect(panel.width).toBeLessThan(260)
  await head.hover()
  const b = (await head.getByRole('button', { name: 'Open project' }).boundingBox())!
  expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width)
  // The view's name and its actions never wrap: one line at this width.
  const files = (await page.locator('.files-head').boundingBox())!
  expect(files.height).toBeLessThan(40)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Other devices' }).click()
  await expect(page.locator('.sheet')).toContainText('Other devices')
  // Back to the default width for the checks after this one.
  await page.evaluate(() => localStorage.removeItem('dakort.explorerWidth'))
})

// The Other devices panel (in the settings menu): on the computer the
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
    const show = page.getByRole('button', { name: 'Show the sidebar', exact: true })
    if (info.project.name !== 'desktop' && (await show.isVisible())) await show.click()
    if (info.project.name === 'desktop') await page.getByRole('button', { name: 'Settings', exact: true }).click()
    else await page.locator('.drawer-foot').getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('menuitem', { name: 'Other devices' }).click()
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

// The devices panel when the server cannot list the addresses: what
// failed in the app's words, the server's reason under it, and Try again.
test('the devices panel says when it cannot read the addresses', async ({ page }, info) => {
  await openSession(page, (l) => l[0])
  let fail = true
  await page.route('**/api/devices', (route) =>
    fail
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'madetest: exit status 1' })
      : route.fulfill({ json: { tailscale: 'down', addrs: [], localUrl: 'http://127.0.0.1:3003/', passwordSet: true, local: true } }),
  )
  const show = page.getByRole('button', { name: 'Show the sidebar', exact: true })
  if (info.project.name !== 'desktop' && (await show.isVisible())) await show.click()
  if (info.project.name === 'desktop') await page.getByRole('button', { name: 'Settings', exact: true }).click()
  else await page.locator('.drawer-foot').getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Other devices' }).click()
  const sheet = page.locator('.sheet')
  const alert = sheet.getByRole('alert')
  await expect(alert).toContainText("Could not read this computer’s addresses.")
  await expect(alert).toContainText('madetest: exit status 1')
  await expect(sheet).not.toContainText('…')
  fail = false
  await sheet.getByRole('button', { name: 'Try again' }).click()
  await expect(alert).toHaveCount(0)
  await expect(sheet).toContainText('not running')
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

// The phone's tab row (the owner's "lth": a neighbour cut to its last
// letters at the left edge). With several tabs it shows the active one
// whole, the row wide, and nothing else; a swipe shows the next one; a
// title too long for its tab fades out at its end. Every
// control in the header is a 44 px target. File tabs, so no session but
// the first is needed.
test('the phone tab row never cuts a tab at its left edge; header targets are 44 px', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'the phone row')
  const s = await openSession(page, (l) => l[0])
  const ids = [s.id, ...['a-rather-long-file-name-for-the-strip.md', 'notes.md', 'another-long-name-to-cut-off.ts', 'x.go'].map((n) => 'f:madetest-' + n)]
  const strip = page.locator('.tabs-row .tabs')
  const look = () =>
    strip.evaluate((el) => {
      const s = el.getBoundingClientRect()
      const tabs = [...el.querySelectorAll<HTMLElement>('[data-tab]')].map((t) => {
        const r = t.getBoundingClientRect()
        const title = t.querySelector<HTMLElement>('.ellipsis')!
        return {
          id: t.dataset.tab,
          seen: Math.min(r.right, s.right) - Math.max(r.left, s.left) > 0.5,
          cutLeft: r.left < s.left - 0.5,
          cutRight: r.right > s.right + 0.5,
          titleCut: title.scrollWidth > title.clientWidth + 1,
          ellipsis: getComputedStyle(title).textOverflow,
        }
      })
      const a = el.querySelector('.tab.active')!.getBoundingClientRect()
      return { tabs, fade: getComputedStyle(el).webkitMaskImage || getComputedStyle(el).maskImage, activeClear: s.right - a.right, more: el.hasAttribute('data-more-right') }
    })
  for (const active of [ids[2], ids[4], ids[3]]) {
    await seedTabs(page, s.folder!, { ids, active })
    await page.reload()
    await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', active)
    await page.waitForTimeout(300) // titles arrive, the row settles
    const { tabs, fade, activeClear } = await look()
    // With several tabs one shows at a time, the row wide: nothing peeks in
    // beside the count (a lone faded icon read as a disabled button), so
    // there is nothing to fade either.
    expect(tabs.filter((t) => t.seen).map((t) => t.id)).toEqual([active])
    expect(Math.abs(activeClear)).toBeLessThan(1)
    expect(fade).not.toContain('gradient')
    for (const t of tabs.filter((t) => t.seen)) {
      expect(t.cutLeft, `${t.id} cut at the left edge`).toBe(false)
      if (t.titleCut) expect(t.ellipsis, `${t.id}'s title cut without its end fading`).toBe('clip')
    }
    expect(tabs.find((t) => t.id === active)).toMatchObject({ seen: true, cutLeft: false, cutRight: false })
    if (tabs.some((t) => t.seen && t.cutRight)) expect(fade, 'a tab cut at the right edge fades out').toContain('gradient')
  }
  // A swipe (a touch, then the row moves) comes to rest on the next tab,
  // whole, and shows it. A scroll with no touch, as WebKit's on reload,
  // never picks a tab: the three reloads above would have switched it.
  await strip.evaluate((el) => {
    el.dispatchEvent(new Event('touchstart', { bubbles: true }))
    el.scrollBy({ left: 60 })
  })
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', ids[4])
  await page.waitForTimeout(300)
  for (const t of (await look()).tabs.filter((t) => t.seen)) expect(t.cutLeft, `${t.id} cut at the left edge after a swipe`).toBe(false)
  await page.screenshot({ path: 'test-results/phone-tab-row.png' })

  // Every control in the header: the sidebar, the shown tab's ×, the tab
  // count (which one of how many), history, new session.
  const row = page.locator('.editor-panel .tabs-row').first()
  const controls = row.locator('button:visible')
  expect(await controls.count()).toBeGreaterThanOrEqual(5)
  // One × (a tab not in use may show its state's mark in the ×'s slot).
  await expect(row.locator('.tab-x svg:visible')).toHaveCount(1)
  await expect(row.locator('.tab-count')).toHaveText(`${ids.indexOf(ids[4]) + 1}/${ids.length}`)
  for (const b of await controls.all()) {
    const box = (await b.boundingBox())!
    const name = (await b.getAttribute('aria-label')) ?? (await b.textContent())
    expect(box.width, `${name} wide`).toBeGreaterThanOrEqual(44)
    expect(box.height, `${name} tall`).toBeGreaterThanOrEqual(44)
  }
  // A title of a usual length ("Dark mode toggle", 16 characters)
  // shows whole with other tabs open: the × and the count leave it room.
  const short = 'f:madetest-wip.md' // as wide as "Dark mode toggle"
  await seedTabs(page, s.folder!, { ids: [s.id, short, ids[2]], active: short })
  await page.reload()
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', short)
  await page.waitForTimeout(300)
  const fits = await page.locator('.tab.active .ellipsis').evaluate((el) => {
    const r = document.createRange() // the text's own width, the box being wider
    r.selectNodeContents(el)
    return r.getBoundingClientRect().width <= el.clientWidth
  })
  expect(fits, 'a title as long as "Dark mode toggle" uncut').toBe(true)
  // A longer one fades out at its end rather than ending in "…".
  expect(await page.locator('.tab.active .ellipsis').evaluate((el) => getComputedStyle(el).textOverflow)).toBe('clip')

  // The ×'s target is beside the title, not over it: a tap at a title's
  // end shows the tab, it does not close it.
  const titleEnd = await page.locator('.tab.active .ellipsis').evaluate((el) => el.getBoundingClientRect().right)
  expect((await page.locator('.tab.active .tab-x').boundingBox())!.x).toBeGreaterThanOrEqual(titleEnd - 0.5)

  // One tab: no count, and its × is there, 44 px.
  await seedTabs(page, s.folder!, { ids: [s.id], active: s.id })
  await page.reload()
  await expect(page.locator('.tab')).toHaveCount(1)
  await expect(page.locator('.tab-count')).toHaveCount(0)
  const x = (await page.locator('.tab .tab-x').boundingBox())!
  expect(Math.min(x.width, x.height)).toBeGreaterThanOrEqual(44)
})

// On a phone a long press on a tab opens its menu (the laptop's
// right-click menu): hung from the tab, inside the screen, with the tab's
// whole title and 44 px rows.
test('a long press on a phone tab opens its menu under the tab', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'right-click on a laptop')
  const s = await openSession(page, (l) => l[0])
  const tab = page.locator(`.tab[data-tab="${s.id}"]`)
  await tab.dispatchEvent('touchstart')
  await page.waitForTimeout(700)
  await tab.dispatchEvent('touchend')
  const menu = page.locator('.tab-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.menu-title')).toHaveText(s.title)
  await expect(menu.getByRole('menuitem', { name: 'Copy resume command' })).toBeVisible()
  const m = (await menu.boundingBox())!
  const t = (await tab.boundingBox())!
  const vw = page.viewportSize()!
  expect(m.x).toBeGreaterThanOrEqual(0)
  expect(m.x + m.width).toBeLessThanOrEqual(vw.width)
  expect(m.y).toBeGreaterThanOrEqual(t.y + t.height - 1)
  for (const item of await menu.getByRole('menuitem').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
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
  // The rows joined: on a phone's width a prompt and the command typed
  // after it wrap, which cut the command's words across two rows.
  const seen = async (s: string) => ((await screen.innerText()).replace(/\n/g, '').match(new RegExp(s, 'g')) ?? []).length
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
  // The terminal follows the theme: its background is the panel's, light
  // and dark, and switches while open.
  const bg = () =>
    page.evaluate(() => {
      const panel = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()
      const v = document.querySelector<HTMLElement>('.term-view:not([style*="none"]) .xterm-scrollable-element')!
      const c = document.createElement('div')
      c.style.color = panel
      document.body.append(c)
      const want = getComputedStyle(c).color
      c.remove()
      return { want, got: getComputedStyle(v).backgroundColor }
    })
  let b = await bg()
  expect(b.got).toBe(b.want)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await expect.poll(async () => ((b = await bg()), b.got === b.want)).toBe(true)
  expect(b.got).not.toBe('rgb(253, 252, 250)') // not the light panel
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
  // The phone's header keeps its room for the tab: the terminal is a row
  // at the drawer's foot.
  const openTerminal = async () => {
    await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  }
  await openTerminal()
  const panel = page.getByRole('region', { name: 'Terminal' })
  await expect(panel).toBeVisible()
  const box = (await panel.boundingBox())!
  expect(box.width).toBe(page.viewportSize()!.width) // the whole screen
  const screen = panel.locator('.term-view:visible .xterm-rows')
  // The rows joined: on a phone's width a prompt and the command typed
  // after it wrap, which cut the command's words across two rows.
  const seen = async (s: string) => ((await screen.innerText()).replace(/\n/g, '').match(new RegExp(s, 'g')) ?? []).length
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

  // The key that puts the keyboard away is pinned at the row's right end,
  // and takes the focus out of the shell.
  const hide = keys.getByRole('button', { name: 'Hide the keyboard' })
  const bar = (await keys.boundingBox())!
  const hb = (await hide.boundingBox())!
  expect(Math.abs(bar.x + bar.width - (hb.x + hb.width))).toBeLessThanOrEqual(12)
  expect(hb.width).toBeGreaterThanOrEqual(44)
  await hide.click()
  expect(await page.evaluate(() => !!document.activeElement?.closest('.term-view'))).toBe(false)

  await panel.getByRole('button', { name: 'Hide the terminal' }).click()
  await expect(panel).toHaveCount(0)
  await openTerminal()
  await expect.poll(() => seen('madetest-after'), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  for (const t of await (await page.request.get('/api/terms?folder=' + encodeURIComponent(folder))).json()) await page.request.post(`/api/terms/${t.id}/close`, { data: {} })
}

// The activity bar (laptop only), VS Code's: the mark on top, a button
// per sidebar view with the one shown marked, the history and terminal
// after them, the settings at the foot. A view's button switches the
// sidebar to it; the shown one's hides the sidebar, and the bar stays.
// Every status mark has one outer diameter: the filled dot (done,
// unread), the still ring (background tasks), the turning ring
// (running), the needs-you triangle and the failed cross, a ring's stroke counted inside, in each place they stand:
// a project row, a tab, a tool row and a group's header. Each kind is put
// in each place and measured there (the place's own rules apply).
test('status marks are one size everywhere', async ({ page }) => {
  await openSession(page, quiet)
  const places = ['.folder-list .folder-row .row-end', '.tabs-row .tab.active .tab-x', '.transcript .tool-run .tool-line:not(.run-line) .tool-mark', '.transcript .run-line .tool-mark']
  await page.locator('.transcript .run-line').first().click()
  if (!(await page.locator('.folder-list').isVisible())) await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  const sizes = await page.evaluate((places) => {
    const out: Record<string, [number, number]> = {}
    const painted_: Record<string, number> = {}
    for (const place of places) {
      const host = document.querySelector<HTMLElement>(place)
      if (!host) {
        out[place + ' (missing)'] = [0, 0]
        continue
      }
      for (const kind of ['done', 'unread', 'failed', 'tasks', 'run', 'needs', 'fail']) {
        const d = document.createElement('span')
        d.className = 'dot ' + kind
        d.style.display = 'inline-block' // a tab shows its mark only when not in use
        host.append(d)
        const r = d.getBoundingClientRect()
        out[`${place} ${kind}`] = [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]
        // What the eye sees: a solid dot paints only its content box, so
        // every solid one must keep the same inset wherever it stands (a
        // later colour rule once reset it and the red dot looked bigger).
        const cs = getComputedStyle(d)
        const painted = cs.backgroundClip === 'content-box' ? r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : r.width
        painted_[`${place} ${kind}`] = Math.round(painted * 10) / 10
        d.remove()
      }
    }
    return { out, painted_ }
  }, places)
  const all = Object.entries(sizes.out)
  expect(all.length).toBe(places.length * 7)
  const solid = Object.entries(sizes.painted_).filter(([k]) => /(done|unread|failed)$/.test(k))
  for (const [where, p] of solid) expect(p, where + ' painted').toBe(solid[0][1])
  expect(solid[0][1]).toBeLessThan(all[0][1][0])
  for (const [where, [w, h]] of all) {
    expect([w, h], where).toEqual(all[0][1])
    expect(w, where).toBeGreaterThan(0)
  }
})

// The sidebar names its view and has no row of tabs.
test('the activity bar switches and hides the sidebar', async ({ page }, info) => {
  await openSession(page, quiet)
  if (info.project.name !== 'desktop') {
    await expect(page.locator('.activity-bar')).toHaveCount(0) // the phone has the sheet
    return
  }
  const bar = page.locator('.activity-bar')
  const explorer = bar.getByRole('button', { name: 'File explorer', exact: true })
  const scm = bar.getByRole('button', { name: /^Changes/ })
  const side = page.locator('.explorer-panel')
  await expect(bar.locator('.brand-mark')).toBeVisible()
  await expect(page.locator('.explorer-panel .brand')).toHaveCount(0) // the mark shows once
  await expect(side.locator('.side-tabs')).toHaveCount(0)
  await expect(explorer).toHaveAttribute('aria-pressed', 'true')
  await expect(side.locator('.files-head .explorer-title')).toHaveText('File explorer')
  await scm.click()
  await expect(scm).toHaveAttribute('aria-pressed', 'true')
  await expect(explorer).toHaveAttribute('aria-pressed', 'false')
  await expect(side.locator('.files-head .explorer-title')).toHaveText('Changes')
  // The view shown, again: the sidebar goes, the bar stays, nothing marked.
  await scm.click()
  await expect(side).toHaveCount(0)
  await expect(bar).toBeVisible()
  await expect(scm).toHaveAttribute('aria-pressed', 'false')
  // Another view's button brings it back on that view.
  await explorer.click()
  await expect(side.locator('.files-head .explorer-title')).toHaveText('File explorer')
  // The tab bar's own hide button still hides it.
  await page.getByRole('button', { name: 'Hide the sidebar', exact: true }).click()
  await expect(side).toHaveCount(0)
  await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  await expect(side).toBeVisible()
  // The history is not in the bar: it stays on the pane's own bar, by
  // New session. The settings menu opens from the bar's foot.
  await expect(bar.getByRole('button', { name: 'Session history' })).toHaveCount(0)
  await page.locator('.tabs-row').getByRole('button', { name: 'Session history' }).first().click()
  await expect(page.locator('.history[role="dialog"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await bar.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'Other devices' })).toBeVisible()
  // Closed with a click elsewhere: closed with Escape, the focus goes
  // back to the gear, visibly, and its tip shows (as it should).
  await page.mouse.click(600, 400)
  await expect(page.getByRole('menuitem', { name: 'Other devices' })).toHaveCount(0)
  // Its tips sit to the right of the icon, 6 px off.
  await explorer.hover()
  const tip = page.locator('#tip[data-open]')
  await expect(tip).toHaveText('File explorer')
  const e = (await explorer.boundingBox())!
  expect(Math.round((await tip.boundingBox())!.x - (e.x + e.width))).toBe(6)
})
