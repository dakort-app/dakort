import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const token = process.env.DAKORT_TOKEN ?? ''
test.skip(!token, 'DAKORT_TOKEN not set')

type Session = { id: string; folder?: string; cwd?: string; size: number; title: string; heldBy?: number; provider?: string; updated?: string }

// quiet picks the newest Claude session nothing is writing to: not held by
// a live CLI and no row in the last 10 minutes. The newest session overall
// is often one in use while the checks run (the one shipping, or another
// turn in progress), and a check that reads it twice saw it change between.
const quiet = (l: Session[]) =>
  l.find((s) => s.provider !== 'codex' && !s.heldBy && Date.now() - Date.parse(s.updated ?? '') > 10 * 60_000) ?? l[0]

// Where the app keeps a folder's tabs (local.ts: a Windows path's case folded).
const tabsKey = (folder: string) => 'dakort.tabs:' + (/^[a-z]:[\\/]/i.test(folder) ? folder.toLowerCase() : folder)

// seedTabs sets a folder's tabs as a device would have them: the shared
// list on the server (the project's) and this page's view in local storage.
type Pane = { ids: string[]; active: string }
async function seedTabs(page: Page, folder: string, t: Pane & { right?: Pane }) {
  await page.request.post('/api/tabs', { data: { folder, ids: [...t.ids, ...(t.right?.ids ?? [])] } })
  await page.evaluate(([key, t]) => localStorage.setItem(key, JSON.stringify(t)), [tabsKey(folder), t] as const)
}

// openSession logs in, opens the session's folder with that session as
// its only tab, and waits for the transcript.
async function openSession(page: Page, pick: (s: Session[]) => Session) {
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

// Folders this test opened (not ones already open) go back off the folder
// bar afterwards.
const opened: string[] = []
test.afterEach(async ({ page }) => {
  for (const path of opened.splice(0)) await page.request.post('/api/folders/close', { data: { path } })
})

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

// The largest session: many pages above, long tool output, images.
test('a big session at phone size, with older pages loading in place', async ({ page }) => {
  await openSession(page, (l) => l.reduce((a, b) => (b.size > a.size ? b : a)))

  // Nothing wider than the screen.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)

  // The composer and its send button are on screen, not pushed below it.
  const send = await page.locator('.composer .send').boundingBox()
  const vh = await page.evaluate(() => window.innerHeight)
  expect(send).not.toBeNull()
  expect(send!.y + send!.height).toBeLessThanOrEqual(vh)
  expect(send!.x + send!.width).toBeLessThanOrEqual(page.viewportSize()!.width)

  // The transcript fits its box and scrolls inside it (a layout change once
  // let it grow past the box, clipped and unscrollable, on the laptop).
  const box = page.locator('.transcript')
  const fit = await box.evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    vh: window.innerHeight,
    scrollable: el.scrollHeight > el.clientHeight,
  }))
  expect(fit.bottom).toBeLessThanOrEqual(fit.vh)
  expect(fit.scrollable).toBe(true)

  // It opens at the newest message.
  const gap = await box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(gap).toBeLessThan(80)

  // WebKit has no scroll anchoring of its own (Chrome does, which can hide
  // a broken anchor), so this checks the app's own. Each step scrolls to
  // the top, or (odd steps) to 1.5 screens below it, where older rows now
  // load early, and waits for them: what was on screen must stay where it
  // was.
  for (let step = 0; step < 4; step++) {
    const r = await box.evaluate(async (el, stopShort) => {
      el.scrollTop = stopShort ? 1.5 * el.clientHeight : 0
      await new Promise((r) => requestAnimationFrame(r))
      const boxTop = el.getBoundingClientRect().top
      const items = Array.from(el.querySelectorAll<HTMLElement>('[data-anchor]'))
      const first = items.find((x) => x.getBoundingClientRect().bottom > boxTop)!
      const key = first.dataset.anchor!
      const before = items.length
      const top = first.getBoundingClientRect().top
      for (let i = 0; i < 40 && el.querySelectorAll('[data-anchor]').length === before; i++) await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 300))
      const same = el.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(key)}"]`)
      return {
        before,
        after: el.querySelectorAll('[data-anchor]').length,
        moved: same ? same.getBoundingClientRect().top - top : null,
      }
    }, step % 2 === 1)
    console.log(`older page ${step + 1} (${step % 2 ? '1.5 screens down' : 'top'}): ${r.before} -> ${r.after} items, anchor moved ${r.moved} px`)
    if (r.after === r.before) break // reached the start
    expect(r.moved).not.toBeNull()
    expect(Math.abs(r.moved!)).toBeLessThanOrEqual(2)
  }
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

// The mode chip offers VS Code's four modes plus Bypass, and shows the mode
// the session's transcript says it last ran with (a terminal's "auto" once
// came up as the global default, "Ask before edits").
test('the mode chip shows what the session last ran with', async ({ page }) => {
  const s = await openSession(page, quiet)
  const tail: { rows: { role: string; permissionMode?: string }[] } = await (await page.request.get(`/api/sessions/${s.id}/rows?n=200`)).json()
  const last = tail.rows.filter((r) => r.role === 'user' && r.permissionMode).pop()?.permissionMode
  const chip = page.locator('.mode-chip select')
  expect(await chip.locator('option').allTextContents()).toEqual(
    last === 'dontAsk'
      ? ['Manual', 'Edit automatically', 'Plan', 'Auto', 'Bypass permissions', "Don't ask"]
      : ['Manual', 'Edit automatically', 'Plan', 'Auto', 'Bypass permissions'],
  )
  if (last) await expect(chip).toHaveValue(last === 'default' ? 'manual' : last)
  console.log(`last mode in the transcript: ${last ?? '(none)'}; chip: ${await chip.inputValue()}`)
  // As wide as the mode's name, not the longest option ("Bypass permissions").
  if ((await chip.inputValue()) === 'auto') expect((await page.locator('.mode-chip').boundingBox())!.width).toBeLessThan(80)

  // And the model chip: the last reply's model, not the global default.
  const list: { id: string; used?: { model?: string } }[] = await (await page.request.get('/api/sessions')).json()
  const model = list.find((x) => x.id === s.id)?.used?.model
  const names: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5-1': 'Fable 5.1', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' }
  if (model) await expect(page.locator('.composer .chip-btn')).toContainText(names[model] ?? model)
  console.log(`last model: ${model ?? '(none)'}; chip: ${await page.locator('.composer .chip-btn').textContent()}`)

  // The cache clock's popup holds the idle-compaction switch (on by default).
  const clock = page.locator('.cache-clock')
  if (await clock.count()) {
    await clock.click()
    await expect(page.getByRole('switch', { name: 'Compact when idle' })).toBeVisible()
    await page.screenshot({ path: `test-results/idle-switch-${test.info().project.name}.png` })
  }
})

// The "/" menu lists the commands that work here, narrows as you type, and
// a pick fills the box (never sent here: these are real sessions).
test('the slash menu', async ({ page }, info) => {
  await openSession(page, quiet)
  const box = page.locator('.composer textarea')
  await box.fill('/co')
  const rows = page.locator('.slash-menu .slash-name')
  await expect(rows.first()).toHaveText('/compact', { timeout: 20_000 }) // the CLI is asked on first use
  expect((await rows.allTextContents()).slice(0, 2)).toEqual(['/compact', '/context'])
  await page.screenshot({ path: `test-results/slash-${info.project.name}.png` })
  await box.press('ArrowDown')
  await box.press('Enter')
  await expect(box).toHaveValue('/context ')
  await expect(page.locator('.slash-menu')).toHaveCount(0)
  await box.fill('/') // Escape closes it
  await expect(page.locator('.slash-menu')).toBeVisible()
  await box.press('Escape')
  await expect(page.locator('.slash-menu')).toHaveCount(0)
  await box.fill('')
})

// A Return that arrives while a composition is open (Windows typing suggestions
// holds one at the end of the word being typed) makes no new line, and the
// message goes when the composition ends. The send is answered here, not
// by the server: these are real sessions.
test('a Return during a composition sends when it ends', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Return makes a new line on the phone')
  const s = await openSession(page, (l) => l[0])
  const sent: string[] = []
  await page.route(`**/api/sessions/${s.id}/send`, async (route) => {
    sent.push(route.request().postDataJSON().text)
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ session: s.id, promptId: route.request().postDataJSON().promptId }) })
  })
  const box = page.locator('.composer textarea')
  await box.fill('hello there')
  await box.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))
  })
  await expect(box).toHaveValue('hello there')
  expect(sent).toEqual([])
  await box.evaluate((el) => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'there' })))
  await expect(box).toHaveValue('')
  await expect.poll(() => sent).toEqual(['hello there'])
  await page.unroute(`**/api/sessions/${s.id}/send`)
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

// An image is a small thumbnail; a click shows it large in a popup that a
// click anywhere, or Escape, closes (it used to open a new browser tab).
// A 4K screenshot pasted shows at once and goes out as a PNG Claude takes
// whole (2576 px, 3.75 MP), even when Send comes before it has shrunk. The
// send is caught here and refused, so no CLI runs: the image comes back.
// Files dropped on the transcript attach as + does; a veil shows while
// they are over the session, and anything not an image is named and left.
test('files dropped on a session attach, images only', async ({ page }) => {
  await openSession(page, (l) => l[0])
  const target = page.locator('.session .transcript')
  const dt = await page.evaluateHandle(async () => {
    const c = document.createElement('canvas')
    c.width = c.height = 40
    const png: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([png], 'shot.png', { type: 'image/png' }))
    dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    return dt
  })
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(page.locator('.drop-veil')).toBeVisible()
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  await target.dispatchEvent('drop', { dataTransfer: dt })
  await expect(page.locator('.drop-veil')).toHaveCount(0)
  await expect(page.locator('.composer .attachment img')).toHaveCount(1)
  await expect(page.locator('.composer .notice.error')).toContainText('notes.txt was left out')
  await page.locator('.composer .attachment .tab-x').click()
  await page.locator('.composer .notice.error').click()
})

test('a pasted screenshot shows at once and goes as a sharp PNG', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  let sent: { images?: { mediaType: string; data: string }[] } | null = null
  await page.route(`**/api/sessions/${s.id}/send`, (route) => {
    sent = route.request().postDataJSON()
    return route.fulfill({ status: 500, json: { error: 'madetest: not sent' } })
  })
  const box = page.locator('.composer textarea')
  await box.fill('madetest: what is on this screen?')
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 3840
    c.height = 2400
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#222'
    g.font = '28px sans-serif'
    for (let y = 40; y < c.height; y += 36) g.fillText('a line of small screenshot text ' + y, 20, y)
    const png: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([png], 'image.png', { type: 'image/png' }))
    document.querySelector('.composer textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.composer .attachment img')).toHaveCount(1)
  await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click() // at once, before the image has shrunk
  await expect(page.locator('.composer .notice.error')).toContainText('madetest: not sent')
  const img = sent!.images![0]
  expect(img.mediaType).toBe('image/png')
  const [w, h] = await page.evaluate(async (d) => {
    const b = await createImageBitmap(await (await fetch('data:image/png;base64,' + d)).blob())
    return [b.width, b.height]
  }, img.data)
  expect(w * h).toBeLessThanOrEqual(3_750_000)
  expect(w).toBeGreaterThan(2400)
  // Refused: the image and the text are back in the box.
  await expect(page.locator('.composer .attachment img')).toHaveCount(1)
  await expect(box).toHaveValue(/madetest/)
  await page.locator('.composer .attachment .tab-x').click()
  await box.fill('')
})

// A reloaded page knows nothing of running turns, so it must ask for the
// snapshot (no last id): resuming the stream replays only what came after
// that id, and a turn started before it showed no Stop until it ended.
test('a reloaded page asks for the snapshot of running turns', async ({ page }) => {
  await openSession(page, (l) => l[0])
  await expect(page.locator('.dot.ok').first()).toBeAttached()
  const asked = page.waitForRequest((r) => r.url().includes('/api/events'))
  await page.reload()
  expect(new URL((await asked).url()).searchParams.get('last')).toBe('')
})

test('images open in a popup', async ({ page }, info) => {
  await openSession(page, (l) => l[0])
  const thumb = page.locator('.transcript .thumb').last()
  for (let i = 0; i < 10 && !(await thumb.count()); i++) await page.locator('.transcript').evaluate((el) => (el.scrollTop = 0)).then(() => page.waitForTimeout(800))
  test.skip(!(await thumb.count()), 'no image in the loaded part of the session')
  await thumb.scrollIntoViewIfNeeded()
  const tb = (await thumb.boundingBox())!
  expect(tb.height).toBeLessThanOrEqual(60)
  expect(tb.width).toBeLessThanOrEqual(124) // a wide screenshot once spanned the whole prompt
  await thumb.click()
  await expect(page.locator('.lightbox img')).toBeVisible()
  await page.screenshot({ path: `test-results/lightbox-${info.project.name}.png` })
  await page.locator('.lightbox').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.lightbox')).toHaveCount(0)
  await thumb.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.lightbox')).toHaveCount(0)
})

// Copy under a reply puts its answer on the clipboard (caught here, so the
// test does not depend on the browser's clipboard permission).
test('a reply copies its answer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void ((window as any).copied = t) } })
  })
  // A real session at rest: not a test's one-turn throwaway (newest after a
  // Go run), and not one a Claude is working in (often the one shipping
  // this, whose tail is one unfinished reply with nothing to copy yet).
  // Sessions change while the checks run, so try a few.
  const btn = page.locator('.transcript .copy-btn').last()
  for (let i = 0; i < 4; i++) {
    await openSession(page, (l) => l.filter((s) => s.size > 500_000 && !s.heldBy)[i] ?? l[0])
    if (await btn.count()) break
  }
  await btn.scrollIntoViewIfNeeded()
  await btn.click()
  await expect(btn).toHaveAttribute('aria-label', 'Copied')
  const copied: string = await page.evaluate(() => (window as any).copied)
  expect(copied.trim().length).toBeGreaterThan(0)
  await expect(btn).toHaveAttribute('aria-label', 'Copy', { timeout: 3000 })
})

// A code block copies just its code, from a button in its corner that
// stays there when the block scrolls sideways. Shown in a Markdown file
// served by the test (the renderer is the transcript's).
test('a code block copies its code', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void ((window as any).copied = t) } })
  })
  const s = await openSession(page, (l) => l[0])
  const name = 'madetest-notes.md'
  const code = 'You are reviewing one section.\nRules: ' + 'a long line that scrolls sideways, '.repeat(8) + '<b>kept</b>'
  const body = 'Paste this:\n\n```text\n' + code + '\n```\n\nThen go.\n'
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-10-30T00:00:00Z', complete: true } })
    return route.fulfill({ body, contentType: 'text/markdown' })
  })
  const tab = 'f:' + name
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const block = page.locator('.md .code-block')
  await expect(block).toHaveCount(1)
  const btn = block.locator('button.code-copy') // by class: its name changes to Copied
  const at = (await btn.boundingBox())!
  await block.locator('pre').evaluate((el) => (el.scrollLeft = 200))
  expect((await btn.boundingBox())!.x).toBe(at.x)
  await block.hover()
  await btn.click()
  await expect(btn).toHaveAttribute('aria-label', 'Copied')
  expect(await page.evaluate(() => (window as any).copied)).toBe(code)
  await page.screenshot({ path: `test-results/code-copy-${test.info().project.name}.png` })
  await expect(btn).toHaveAttribute('aria-label', 'Copy code', { timeout: 3000 })
})

// On plain HTTP (the tailnet address) there is no clipboard API at all;
// Copy falls back to a selected textarea and execCommand('copy'), which
// works there in every browser. The real execCommand runs; its argument
// and the selected text are noted on the way.
test('a reply copies its answer without the clipboard API', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined })
    const real = document.execCommand.bind(document)
    document.execCommand = (cmd: string, ...rest: any[]) => {
      const ta = document.querySelector<HTMLTextAreaElement>('body > textarea')
      ;(window as any).copied = cmd === 'copy' && ta?.tagName === 'TEXTAREA' ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ''
      return real(cmd, ...rest)
    }
  })
  const btn = page.locator('.transcript .copy-btn').last()
  for (let i = 0; i < 4; i++) {
    await openSession(page, (l) => l.filter((s) => s.size > 500_000 && !s.heldBy)[i] ?? l[0])
    if (await btn.count()) break
  }
  await btn.scrollIntoViewIfNeeded()
  await btn.click()
  await expect(btn).toHaveAttribute('aria-label', 'Copied')
  const copied: string = await page.evaluate(() => (window as any).copied)
  expect(copied.trim().length).toBeGreaterThan(0)
  // The helper textarea is gone again.
  await expect(page.locator('body > textarea')).toHaveCount(0)
})

// A machine without Claude: the composer says so, with the command that
// installs it and the one that signs in (the app never installs it).
test('a missing CLI is named with its install command', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    const res = await route.fetch()
    const cfg = await res.json()
    cfg.clis = [
      { name: 'claude', found: false, install: 'curl -fsSL https://claude.ai/install.sh | bash', shell: 'a terminal', signIn: 'claude' },
      { name: 'codex', found: false, install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', shell: 'a terminal', signIn: 'codex' },
    ]
    delete cfg.codex
    await route.fulfill({ response: res, json: cfg })
  })
  await page.addInitScript(() => localStorage.setItem('dakort.provider', 'claude'))
  // A small Claude session with rows to show (the smallest are empty).
  await openSession(page, (l) => l.filter((s) => s.provider !== 'codex' && !s.heldBy && s.size > 100_000).sort((a, b) => a.size - b.size)[0])
  const note = page.locator('.composer .missing-cli')
  await expect(note).toContainText('Claude Code is not installed')
  await expect(note.locator('code').first()).toHaveText('curl -fsSL https://claude.ai/install.sh | bash')
  await expect(note.locator('code').nth(1)).toHaveText('claude')
})

// An effort or Chrome picked is the session's at once (the test server's
// settings file, not the live one's): a reload still shows it.
test('an effort and Chrome pick survive a reload', async ({ page }) => {
  await openSession(page, (l) => l.filter((x) => x.provider !== 'codex' && !x.heldBy && x.size > 50_000).sort((a, b) => a.size - b.size)[0])
  const low = page.locator('.picker-panel [aria-label="Effort Low"]')
  const chrome = page.locator('.picker-panel [role=switch][aria-label=Chrome]')
  await page.locator('.composer .chip-btn').click()
  await low.click()
  await expect(low).toHaveClass(/\bon\b/)
  await chrome.click()
  await expect(chrome).toHaveAttribute('aria-checked', 'true')
  await page.waitForTimeout(500) // the post
  await page.reload()
  await expect(page.locator('.composer .chip-btn .chip-chrome')).toBeVisible()
  await page.locator('.composer .chip-btn').click()
  await expect(low).toHaveClass(/\bon\b/)
  await expect(chrome).toHaveAttribute('aria-checked', 'true')
  await chrome.click()
  await expect(chrome).toHaveAttribute('aria-checked', 'false')
  await page.locator('.picker-panel [aria-label="Effort Default"]').click()
  await expect(page.locator('.picker-panel [aria-label="Effort Default"]')).toHaveClass(/\bon\b/)
})

// A Codex thread reads like a Claude session: prompts, replies, tool rows,
// and a Codex chip in the composer with GPT models in the picker; no
// prompt-cache clock (Claude's), no slash menu.
test('a Codex session shows its rows and its own picker', async ({ page }, info) => {
  const sessions: Session[] = await (await page.request.get('/api/sessions', { headers: { Cookie: 'dakort_token=' + token } })).json()
  test.skip(!sessions.some((s) => s.provider === 'codex' && s.folder), 'no Codex session on this machine')
  const s = await openSession(page, (l) => l.filter((x) => x.provider === 'codex').sort((a, b) => b.size - a.size)[0])
  console.log(`codex session: ${s.title} (${(s.size / 1e6).toFixed(1)} MB)`)
  await expect(page.locator('.transcript .reply').first()).toBeVisible()
  await expect(page.locator('.composer .chip', { hasText: 'Codex' })).toBeVisible()
  await expect(page.locator('.composer .cache-clock')).toHaveCount(0)
  await page.locator('.composer .chip-btn').click()
  await expect(page.locator('.picker-panel .picker-row', { hasText: /GPT/ }).first()).toBeVisible()
  await expect(page.locator('.picker-panel', { hasText: 'Ultracode' })).toHaveCount(0)
  await expect(page.locator('.picker-panel [aria-label=Chrome]')).toHaveCount(0)
  await page.screenshot({ path: `test-results/codex-${info.project.name}.png` })
  await page.keyboard.press('Escape')
  await page.locator('.composer textarea').fill('/')
  await expect(page.locator('.slash-menu')).toHaveCount(0)
  await page.locator('.composer textarea').fill('')
})

// The explorer lists newest first until A–Z is picked, remembered on the
// device. Folders come first either way.
test('the explorer sorts by date or by name', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  await page.addInitScript(() => localStorage.removeItem('dakort.filesSort'))
  await openSession(page, (l) => l[0])
  const panel = page.locator('.explorer-panel')
  await panel.locator('.tree-row').first().waitFor()
  await expect(panel.locator('.files-sort .chip-btn.on')).toHaveText('Recent')
  const files = () => panel.locator('.tree-row:not(:has(svg)) .ellipsis').allTextContents()
  await panel.locator('.files-sort').getByRole('button', { name: 'A–Z' }).click()
  const named = await files()
  const lower = (s: string) => s.toLowerCase()
  expect(named).toEqual([...named].sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0))) // the server's order
  expect(await page.evaluate(() => localStorage.getItem('dakort.filesSort'))).toBe('name')
  await page.screenshot({ path: 'test-results/explorer-sort.png' })
  await panel.locator('.files-sort').getByRole('button', { name: 'Recent' }).click()
  await expect(panel.locator('.files-sort .chip-btn.on')).toHaveText('Recent')
})

// A CSV opens as a table: the header stays at the top while the rows
// scroll, quoted fields keep their commas, only the rows in view are
// drawn, and Source shows the text. Served by the test, as the Word file.
test('a CSV file shows as a table', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const name = 'madetest-sample.csv'
  const lines = ['id,name,amount']
  for (let i = 1; i <= 5000; i++) lines.push(`${i},"Smith, row ${i}",${(i * 1.5).toFixed(2)}`)
  const body = lines.join('\r\n') + '\r\n'
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-11-07T00:00:00Z' } })
    return route.fulfill({ body, contentType: 'text/csv' })
  })
  const tab = 'f:' + name
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const table = page.locator('.csv-table')
  await expect(table.locator('thead th')).toHaveText(['', 'id', 'name', 'amount'])
  await expect(table.locator('tbody tr').nth(0)).toContainText('Smith, row 1')
  await expect(page.locator('.csv-foot')).toHaveText(/5,000 rows × 3 columns/)
  expect(await table.locator('tbody tr').count()).toBeLessThan(200)
  await expect(table.locator('tbody tr').first().locator('td.num')).toHaveText(['1', '1.50']) // id and amount, not name

  // Far down: those rows drawn, the header still at the top of the box.
  const box = page.locator('.csv-box')
  await box.evaluate((b) => (b.scrollTop = 26 * 3000))
  await expect(table.locator('tbody td', { hasText: 'Smith, row 3005' })).toBeVisible()
  const top = (await box.boundingBox())!.y
  expect(Math.abs((await table.locator('thead th').nth(1).boundingBox())!.y - top)).toBeLessThan(2)
  await page.screenshot({ path: `test-results/csv-${info.project.name}.png` })

  await page.locator('.file-head').getByRole('button', { name: 'Source' }).click()
  await expect(page.locator('.cm-content')).toContainText('id,name,amount')
  await page.locator('.file-head').getByRole('button', { name: 'Table' }).click()
  await expect(table).toBeVisible()
})

// Editing a text file: the source is editable at once on a laptop, after
// Edit on a phone. Save and Revert show only with changes; Ctrl+S sends
// the text with the version it was edited from; a change on disk is taken
// in while nothing is typed, and with typing pending a refused save offers
// Reload and Overwrite. Not UTF-8: read-only. Served by the test, so
// nothing is written.
test('a text file can be edited and saved', async ({ page }) => {
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  const s = await openSession(page, (l) => l[0])
  const name = 'madetest-notes.md'
  let disk = { body: '# Notes\n\nfirst line\n', tag: '"v1"', mtime: '2026-11-09T00:00:00Z' }
  const saves: { text: string; base: string }[] = []
  let refuse = false
  await page.route(/\/api\/files\/(stat|raw|save)\?/, (route) => {
    const u = new URL(route.request().url())
    const p = u.searchParams.get('path')
    if (p === 'madetest-latin.txt') {
      if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: 5, mtime: disk.mtime } })
      return route.fulfill({ body: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), contentType: 'application/octet-stream', headers: { ETag: '"l"' } })
    }
    if (p !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: disk.body.length, mtime: disk.mtime } })
    if (u.pathname.endsWith('/raw')) return route.fulfill({ body: disk.body, contentType: 'application/octet-stream', headers: { ETag: disk.tag } })
    const req = route.request().postDataJSON() as { text: string; base: string }
    saves.push(req)
    if (refuse && req.base !== '*') return route.fulfill({ status: 412, json: { error: 'the file changed since you opened it' } })
    disk = { body: req.text, tag: `"v${saves.length + 1}"`, mtime: `2026-11-09T00:00:0${saves.length}Z` }
    return route.fulfill({ json: { etag: disk.tag } })
  })
  const tab = 'f:' + name
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const head = page.locator('.file-head')
  await expect(page.locator('.file-md')).toContainText('first line')
  if (touch) {
    await expect(head.getByRole('button', { name: 'Source' })).toBeVisible()
    await head.getByRole('button', { name: 'Edit' }).click()
  } else {
    await expect(head.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    await head.getByRole('button', { name: 'Source' }).click()
  }
  const content = page.locator('.cm-content')
  await expect(content).toContainText('first line')
  await expect(content).toHaveAttribute('contenteditable', 'true')
  await expect(head.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect(head.getByRole('link', { name: 'Download' })).toBeVisible()
  await content.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('added\n')
  await expect(head).toContainText('•')
  await expect(head.getByRole('button', { name: 'Revert' })).toBeVisible()
  await expect(head.getByRole('button', { name: 'Preview' })).toHaveCount(0) // the typing stays on screen
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0]).toEqual({ text: '# Notes\n\nfirst line\nadded\n', base: '"v1"' })
  await expect(head).not.toContainText('•')
  await expect(head.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)

  // Changed on disk with nothing typed: taken in.
  disk = { body: '# Notes\n\nfrom the agent\n', tag: '"agent1"', mtime: '2026-11-09T00:01:00Z' }
  await expect(content).toContainText('from the agent', { timeout: 10_000 })
  await expect(page.locator('.edit-conflict')).toHaveCount(0)

  // Typing pending and a refused save: Reload and Overwrite.
  await content.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('mine\n')
  refuse = true
  await page.keyboard.press('ControlOrMeta+s')
  const conflict = page.locator('.edit-conflict')
  await expect(conflict).toBeVisible()
  await expect(content).toContainText('mine') // the typing is kept
  await conflict.getByRole('button', { name: 'Overwrite' }).click()
  await expect(conflict).toHaveCount(0)
  expect(saves.at(-1)).toEqual({ text: '# Notes\n\nfrom the agent\nmine\n', base: '*' })

  // Revert drops the typing.
  await content.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('scrap')
  await head.getByRole('button', { name: 'Revert' }).click()
  await expect(content).not.toContainText('scrap')
  await expect(head).not.toContainText('•')

  // On a phone, Done with unsaved typing asks first.
  if (touch) {
    await content.click()
    await page.keyboard.type('x')
    page.once('dialog', (d) => d.dismiss())
    await head.getByRole('button', { name: 'Done' }).click()
    await expect(head.getByRole('button', { name: 'Done' })).toBeVisible()
    page.once('dialog', (d) => d.accept())
    await head.getByRole('button', { name: 'Done' }).click()
    await expect(head.getByRole('button', { name: 'Edit' })).toBeVisible()
  }

  // Not UTF-8: shown read-only.
  const latin = 'f:madetest-latin.txt'
  await seedTabs(page, s.folder!, { ids: [s.id, latin], active: latin })
  await page.reload()
  await expect(page.locator('.cm-content')).toContainText('caf')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  await expect(head.getByRole('button', { name: 'Edit' })).toHaveCount(0)
})

// An SVG shows as a picture with its source a tap away; video and audio
// get the browser's players. Served by the test.
test('SVG, video and audio files show', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#3b6ea8"/></svg>'
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    const p = u.searchParams.get('path') ?? ''
    if (!p.startsWith('madetest-')) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: svg.length, mtime: '2026-11-07T00:00:00Z' } })
    return route.fulfill({ body: p.endsWith('.svg') ? svg : '', contentType: p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream' })
  })
  const tabs = ['f:madetest-pic.svg', 'f:madetest-clip.mp4', 'f:madetest-song.mp3']
  await seedTabs(page, s.folder!, { ids: [s.id, ...tabs], active: tabs[0] })
  await page.reload()
  const img = page.locator('.file-image img')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(120)
  await page.locator('.file-head').getByRole('button', { name: 'Source' }).click()
  await expect(page.locator('.cm-content')).toContainText('<rect')
  await page.locator('.file-head').getByRole('button', { name: 'Picture' }).click()
  await expect(img).toBeVisible()

  // On a phone only the active tab shows, so each file is made active.
  await seedTabs(page, s.folder!, { ids: [s.id, ...tabs], active: tabs[1] })
  await page.reload()
  await expect(page.locator('.file-image video[controls]')).toHaveCount(1)
  await seedTabs(page, s.folder!, { ids: [s.id, ...tabs], active: tabs[2] })
  await page.reload()
  await expect(page.locator('.file-image audio[controls]')).toHaveCount(1)
})

// An HTML file shows as source, never rendered in the app. On the computer
// itself a button has the computer's browser open it; elsewhere a link
// opens it as a sandboxed page. The test answers /api/here and the open
// call, so no window appears.
test('an HTML file opens outside the app', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  const html = '<h1>Report</h1><script>document.title="ran"</script>'
  let local = false
  const opened: string[] = []
  await page.route('**/api/here', (route) => route.fulfill({ json: { local } }))
  await page.route(/\/api\/files\/(stat|raw|open)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== 'madetest-report.html') return route.fallback()
    if (u.pathname.endsWith('/open')) {
      opened.push(u.searchParams.get('path')!)
      return route.fulfill({ json: { ok: true } })
    }
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: html.length, mtime: '2026-11-07T00:00:00Z' } })
    return route.fulfill({ body: html, contentType: 'application/octet-stream' })
  })
  const tab = 'f:madetest-report.html'
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  await expect(page.locator('.cm-content')).toContainText('<h1>Report</h1>')
  const link = page.locator('.file-head a', { hasText: 'Open in new tab' })
  await expect(link).toHaveAttribute('href', /html=1/)
  await expect(link).toHaveAttribute('target', '_blank')

  local = true
  await page.reload()
  await page.locator('.file-head').getByRole('button', { name: 'Open in browser' }).click()
  await expect.poll(() => opened).toEqual(['madetest-report.html'])
  await expect(page.locator('.file-head a', { hasText: 'Open in new tab' })).toHaveCount(0)
})

// A spreadsheet is not shown: a note says what to do, and on the computer
// a button opens it in its program. Nothing of the file is fetched.
test('a spreadsheet says how to open it', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  let local = false
  const opened: string[] = []
  let fetched = 0
  await page.route('**/api/here', (route) => route.fulfill({ json: { local } }))
  await page.route(/\/api\/files\/(stat|raw|open)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== 'madetest-budget.xlsx') return route.fallback()
    if (u.pathname.endsWith('/open')) {
      opened.push('xlsx')
      return route.fulfill({ json: { ok: true } })
    }
    if (u.pathname.endsWith('/raw')) fetched++
    return route.fulfill({ json: { size: 4096, mtime: '2026-11-07T00:00:00Z' } })
  })
  const tab = 'f:madetest-budget.xlsx'
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const note = page.locator('.office-note')
  await expect(note).toContainText('does not show .xlsx files')
  await expect(note).toContainText('export a sheet as CSV')
  await expect(page.locator('.file-head').getByRole('button', { name: 'Open on the computer' })).toHaveCount(0)

  local = true
  await page.reload()
  await page.locator('.file-head').getByRole('button', { name: 'Open on the computer' }).click()
  await expect.poll(() => opened).toEqual(['xlsx'])
  expect(fetched).toBe(0)
})

// An archive lists what is inside as a tree: a lone top folder starts
// open, folders a zip names only through their files appear, folders
// fold, and the count and unpacked size show below. The test answers the
// listing (the server's own is tested in Go).
test('an archive lists its contents', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  const entries = [
    { name: 'proj/', size: 0, dir: true },
    { name: 'proj/README.md', size: 2048, mtime: '2026-11-01T10:00:00Z' },
    { name: 'proj/src/main.go', size: 1536, mtime: '2026-11-01T10:00:00Z' },
    { name: 'proj/src/util.go', size: 512 },
  ]
  await page.route(/\/api\/files\/(stat|archive)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== 'madetest-bundle.zip') return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: 999, mtime: '2026-11-07T00:00:00Z' } })
    return route.fulfill({ json: { entries } })
  })
  const tab = 'f:madetest-bundle.zip'
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const rows = page.locator('.archive-row')
  await expect(rows).toHaveCount(3) // proj open: src (folded) and README.md
  await expect(rows.nth(0)).toContainText('proj')
  await expect(rows.nth(1)).toContainText('src')
  await expect(rows.nth(2)).toContainText('README.md')
  await expect(rows.nth(2)).toContainText('2.0 KB')
  await expect(page.locator('.csv-foot')).toHaveText('3 files, 4.0 KB unpacked')
  await rows.nth(1).click()
  await expect(rows).toHaveCount(5)
  await expect(rows.nth(2)).toContainText('main.go')
  await rows.nth(0).click()
  await expect(rows).toHaveCount(1)
})

// A Word file opens as pages, shrunk to the width on a phone. The file is
// served by the test (e2e/sample.docx, from make_sample_docx.py), so
// nothing is written into a real folder.
test('a Word file shows as pages', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const name = 'madetest-sample.docx'
  const body = readFileSync(new URL('sample.docx', import.meta.url))
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-10-25T00:00:00Z' } })
    return route.fulfill({ body, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  })
  const tab = 'f:' + name
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const pages = page.locator('.file-docx section.docx')
  await expect(pages).toHaveCount(2)
  await expect(page.locator('.file-docx')).toContainText('Sample report')
  await expect(page.locator('.file-docx')).toContainText('cell 11')
  const box = (await page.locator('.file-docx').boundingBox())!
  const first = (await pages.first().boundingBox())!
  expect(first.width).toBeLessThanOrEqual(box.width)
  await page.screenshot({ path: `test-results/docx-${info.project.name}.png` })

  // Zoom in past the width, and Fit back to it.
  const bar = page.locator('.pdf-bar')
  await bar.getByRole('button', { name: 'Zoom in' }).click()
  await bar.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(async () => (await pages.first().boundingBox())!.width).toBeGreaterThan(first.width * 1.3)
  await bar.getByRole('button', { name: 'Fit' }).click()
  await expect.poll(async () => Math.round((await pages.first().boundingBox())!.width)).toBe(Math.round(first.width))

  // Find: every match is marked, the current one stepped through; a phrase
  // across a bold run and the table cells count.
  const current = () => page.evaluate(() => [...(CSS.highlights.get('docx-find-cur') ?? [])].map((r) => r.toString()).join())
  const marked = () => page.evaluate(() => CSS.highlights.get('docx-find')?.size ?? 0)
  await bar.getByRole('button', { name: 'Find' }).click()
  const find = page.getByLabel('Find in document')
  await expect(find).toBeFocused()
  await find.fill('CELL 1')
  await find.press('Enter')
  await expect(page.locator('.pdf-find')).toContainText('1 / 2')
  expect(await marked()).toBe(2)
  expect(await current()).toBe('cell 1')
  await find.fill('with bold')
  await find.press('Enter')
  await expect(page.locator('.pdf-find')).toContainText('1 / 1')
  expect(await current()).toBe('with bold')
  await find.fill('second page')
  await find.press('Enter')
  await expect(page.locator('.pdf-find')).toContainText('1 / 1')
  await expect(pages.nth(1)).toBeInViewport()
  await page.screenshot({ path: `test-results/docx-find-${info.project.name}.png` })
  await page.getByRole('button', { name: 'Close find' }).click()
  await expect(page.locator('.pdf-find')).toHaveCount(0)
  expect(await marked()).toBe(0)
  // The path sits in the viewer's bar, not on a line of its own.
  await expect(page.locator('.file-head')).toHaveCount(0)
  await expect(bar).toContainText(name)
})

// A PDF fits the width, then the whole page, and finds words on any page
// (e2e/sample.pdf, from make_sample_pdf.py: "needle" once on page 1, twice
// on page 3). Served by the test, as the Word file is.
test('a PDF fits the page and finds words', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const name = 'madetest-sample.pdf'
  const body = readFileSync(new URL('sample.pdf', import.meta.url))
  let mtime = '2026-10-30T00:00:00Z' // a new one is a recompile
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime, complete: true } })
    return route.fulfill({ body, contentType: 'application/pdf' })
  })
  const tab = 'f:' + name
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const pages = page.locator('.pdf-page')
  await expect(pages).toHaveCount(3)
  await expect(page.locator('.file-head')).toHaveCount(0)
  await expect(page.locator('.pdf-bar')).toContainText(name)

  // Fit: the width to start, then the whole page, then the width again;
  // the button names what a click does.
  const fit = page.locator('.pdf-bar').getByRole('button', { name: /^Fit/ })
  await expect(fit).toHaveText('Fit page')
  await fit.click()
  await expect(fit).toHaveText('Fit width')
  const view = (await page.locator('.pdf-pages').boundingBox())!
  await expect.poll(async () => (await pages.first().boundingBox())!.height).toBeLessThanOrEqual(view.height)
  await page.screenshot({ path: `test-results/pdf-page-${info.project.name}.png` })
  await fit.click()
  await expect(fit).toHaveText('Fit page')

  // Fit page shows the page being read, not the one whose last lines are
  // still at the top of the view (it jumped from the Introduction back to
  // the Acknowledgements): page 2 under a strip of page 1.
  await page.evaluate(() => {
    const box = document.querySelector('.pdf-pages') as HTMLElement
    const p = document.querySelectorAll('.pdf-page')[1] as HTMLElement
    box.scrollTop = p.offsetTop - box.offsetTop - 60
  })
  await expect(page.locator('.pdf-bar > span').first()).toHaveText('2 / 3')
  await fit.click()
  await expect(pages.nth(1)).toBeInViewport({ ratio: 0.9 })
  await expect(page.locator('.pdf-bar > span').first()).toHaveText('2 / 3')
  await fit.click()
  await expect(page.locator('.pdf-bar > span').first()).toHaveText('2 / 3')

  // A recompile while the chat tab is in front keeps the page: the hidden
  // viewer measured 0 and came back somewhere else (page 1 in a thesis).
  await page.locator('.tabs .tab').first().click()
  const reloaded = page.waitForRequest((r) => r.url().includes('/api/files/raw?'))
  mtime = '2026-10-30T00:01:00Z'
  await reloaded
  await page.waitForTimeout(300)
  await page.locator('.tabs .tab').nth(1).click()
  await expect(pages.nth(1)).toBeInViewport()
  await expect(page.locator('.pdf-bar > span').first()).toHaveText('2 / 3')
  // To the top, until it stays there: under the full run's load the new
  // version could land after a single scroll and put the reader back on
  // page 2 (as it should), and find then started from there.
  await expect
    .poll(async () => {
      await page.evaluate(() => ((document.querySelector('.pdf-pages') as HTMLElement).scrollTop = 0))
      await page.waitForTimeout(400)
      return page.evaluate(() => (document.querySelector('.pdf-pages') as HTMLElement).scrollTop)
    })
    .toBe(0)

  // Find: Ctrl+F in the view opens it; Enter goes through the matches.
  await pages.first().click()
  await page.keyboard.press('Control+f')
  const box = page.getByLabel('Find in PDF')
  await expect(box).toBeFocused()
  await box.fill('NEEDLE')
  await box.press('Enter')
  await expect(page.locator('.pdf-find')).toContainText('1 / 3')
  await expect(pages.nth(0).locator('.pdf-hit')).toHaveCount(1)
  await box.press('Enter')
  await expect(page.locator('.pdf-find')).toContainText('2 / 3')
  await expect(pages.nth(2).locator('.pdf-hit')).toBeInViewport()
  await page.screenshot({ path: `test-results/pdf-find-${info.project.name}.png` })
  await box.press('Shift+Enter')
  await expect(page.locator('.pdf-find')).toContainText('1 / 3')
  await box.fill('haystack')
  await box.press('Enter')
  await expect(page.locator('.pdf-find')).toContainText('no matches')
  await box.press('Escape')
  await expect(page.locator('.pdf-find')).toHaveCount(0)
  await expect(page.locator('.pdf-hit')).toHaveCount(0)
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

// Hidden stays hidden and shown stays shown across a folder switch (it once
// came back each time, and later stayed hidden after being shown again).
test('the explorer keeps its shown or hidden state across a folder switch', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  const s = await openSession(page, (l) => l[0])
  // A second folder to switch to, opened here (the test server starts
  // with none open) and closed again afterwards.
  const sessions: Session[] = await (await page.request.get('/api/sessions')).json()
  const folders: { path: string; missing?: boolean }[] = await (await page.request.get('/api/folders')).json()
  const there = new Set(folders.filter((f) => !f.missing).map((f) => f.path))
  const second = sessions.find((x) => x.folder && x.folder !== s.folder && there.has(x.folder))
  test.skip(!second, 'needs a session in a second folder')
  await page.request.post('/api/folders/open', { data: { path: second!.folder } })
  opened.push(second!.folder!)
  await page.getByRole('button', { name: 'Hide the sidebar' }).click()
  await page.reload()
  await expect(page.locator('.explorer-panel')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show the sidebar' }).click()
  const other = page.locator('.folder-list .folder-row:not(.on):not(.more)').first()
  await other.click()
  await page.waitForURL((u) => !decodeURIComponent(u.hash).endsWith(s.folder!))
  await expect(page.locator('.explorer-panel')).toHaveCount(1)
})

// A catch-up that fails (a proxy's 502, empty body) shows a red box, which
// goes once a later catch-up works; the transcript retries by itself.
test('a failed catch-up shows an error that clears itself', async ({ page }) => {
  await openSession(page, (l) => l[0])
  // Armed after the page has settled (openSession may load it twice), and
  // the box noted the moment it shows: in a busy session the next catch-up
  // can clear it within milliseconds.
  let failOnce = true
  await page.route(/\/api\/sessions\/[^/]+\/rows\?after=/, (route) => {
    if (!failOnce) return route.fallback()
    failOnce = false
    return route.fulfill({ status: 502, body: '' })
  })
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector('.transcript .notice.error')?.textContent?.includes('502')) (window as any).saw502 = true
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => !!(window as any).saw502)).toBe(true)
  await expect(page.locator('.transcript .notice.error')).toHaveCount(0, { timeout: 8000 })
})

// A Markdown file served by the test, so nothing is written into a real
// folder: stat and raw for this one name are answered here.
async function serveNotes(page: Page, name: string) {
  const body = '# Notes beside the session\n\nA file shown in the other pane while a session runs.\n\n- one\n- two\n'
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-10-29T00:00:00Z' } })
    return route.fulfill({ body, contentType: 'text/plain' })
  })
}

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

test('split view puts a file beside a session', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'split view is for a laptop')
  const s = await openSession(page, (l) => l.filter((x) => x.size > 100_000)[0] ?? l[0])
  const name = 'madetest-notes.md'
  await serveNotes(page, name)
  await seedTabs(page, s.folder!, { ids: ['f:' + name, s.id], active: s.id })
  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  await expect(page.locator('.editor-panel')).toHaveCount(1)

  // The split button keeps the session where it is and opens a new one
  // beside it, focused.
  await page.getByRole('button', { name: 'Split the editor' }).click()
  const panes = page.locator('.editor-panel')
  await expect(panes).toHaveCount(2)
  await expect(panes.nth(0).locator('.tab.active')).toHaveAttribute('data-tab', s.id)
  await expect(panes.nth(1).locator('.tab.active')).toHaveAttribute('data-tab', 'new')
  await expect(panes.nth(1)).toHaveClass(/focused/)
  await seedTabs(page, s.folder!, { ids: ['f:' + name, s.id], active: s.id })
  await page.reload()
  await expect(panes).toHaveCount(1)

  // The tab's menu opens it to the side: the session moves right (focused);
  // the file stays left.
  await page.locator(`.tab[data-tab="${s.id}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open to the side' }).click()
  await expect(panes).toHaveCount(2)
  await expect(panes.nth(1).locator('.tab.active')).toHaveAttribute('data-tab', s.id)
  await expect(panes.nth(1)).toHaveClass(/focused/)
  await expect(panes.nth(0).locator('.tab.active')).toHaveAttribute('data-tab', 'f:' + name)
  await expect(panes.nth(0).locator('.ws-main')).toContainText('Notes beside the session')
  await expect(panes.nth(1).locator('.transcript [data-anchor]').first()).toBeVisible()
  const w = async (i: number) => (await panes.nth(i).boundingBox())!.width
  expect(Math.abs((await w(0)) - (await w(1)))).toBeLessThanOrEqual(4)
  await page.screenshot({ path: 'test-results/split-desktop.png' })

  // Dragged far right, the split stops at three quarters.
  const bar = (await page.locator('.pane-splitter').boundingBox())!
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
  await page.mouse.down()
  await page.mouse.move(bar.x + 2000, bar.y + bar.height / 2, { steps: 5 })
  await page.mouse.up()
  const share = (await w(0)) / ((await w(0)) + (await w(1)))
  expect(share).toBeGreaterThan(0.72)
  expect(share).toBeLessThan(0.77)

  // Remembered for the folder.
  await page.reload()
  await expect(panes).toHaveCount(2)
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), tabsKey(s.folder!))
  expect(saved.right.ids).toEqual([s.id])
  expect(saved.ratio).toBeCloseTo(0.75, 2)
  await page.locator('.pane-splitter').dblclick()
  expect(Math.abs((await w(0)) - (await w(1)))).toBeLessThanOrEqual(4)

  // The tab's menu moves the file over; the left pane, now empty, gives way.
  await panes.nth(0).locator('.tab').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to the right pane' }).click()
  await expect(panes).toHaveCount(1)
  await expect(page.locator('.tabs .tab')).toHaveCount(2)

  // Split again, then close the split: every tab back in one pane, the
  // new session's too.
  await page.getByRole('button', { name: 'Split the editor' }).click()
  await expect(panes).toHaveCount(2)
  await page.getByRole('button', { name: 'Close the split' }).click()
  await expect(panes).toHaveCount(1)
  await expect(page.locator('.tabs .tab')).toHaveCount(3)
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

// A process a turn left running (leftovers.go) shows above the box with
// what it is and for how long, and a Stop; the event is played in and the
// stop faked, so nothing real is ended.
test('a process a turn left running shows with a Stop', async ({ page }, info) => {
  const s = await openSession(page, (l) => l.filter((x) => x.provider !== 'codex' && !x.heldBy)[0] ?? l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  let stops = 0
  await page.route(`**/api/sessions/${s.id}/leftovers/4242/stop`, (route) => {
    stops++
    return route.fulfill({ json: {} })
  })
  await play({ type: 'leftovers', session: s.id, leftovers: [{ pid: 4242, name: 'node.exe', command: 'node playwright test', started: new Date(Date.now() - 3600_000).toISOString() }] })
  const row = page.locator('.leftovers .queued-item')
  await expect(row).toContainText('node.exe')
  await expect(row).toContainText('1h')
  await page.screenshot({ path: `test-results/leftovers-${info.project.name}.png` })
  await row.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => stops).toBe(1)
  await play({ type: 'leftovers', session: s.id })
  await expect(row).toHaveCount(0)
  await page.unroute(`**/api/sessions/${s.id}/leftovers/4242/stop`)
})

// A message sent while a turn runs is queued on the server (queue.go):
// the send says queue, the queue shows above the box with a take-back,
// and a stop puts what was queued back in the box. The turn and the queue
// are played into the page and the server's answers faked: a real session,
// so nothing reaches a CLI.
test('a message sent during a turn is queued, and comes back on a stop', async ({ page }, info) => {
  const s = await openSession(page, (l) => l.filter((x) => x.provider !== 'codex' && !x.heldBy)[0] ?? l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const bodies: Record<string, unknown>[] = []
  await page.route('**/api/sessions/*/send', (route) => {
    const b = route.request().postDataJSON()
    bodies.push(b)
    return route.fulfill({ status: 202, json: { session: s.id, promptId: b.promptId, queued: true } })
  })
  await page.route('**/api/sessions/*/unqueue/*', (route) => route.fulfill({ json: { text: 'madetest first', images: [] } }))
  await page.route('**/api/sessions/*/interrupt', (route) => route.fulfill({ json: { queued: [{ text: 'madetest second', images: [] }] } }))

  await play({ type: 'turn', session: s.id, state: 'running' })
  const box = page.locator('.composer textarea')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue' })).toHaveCount(0)
  await box.fill('madetest first')
  await page.getByRole('button', { name: 'Queue' }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ text: 'madetest first', queue: true })
  await expect(box).toHaveValue('')
  await play({ type: 'queue', session: s.id, queue: [{ promptId: String(bodies[0].promptId), text: 'madetest first' }, { promptId: 'p2', text: 'madetest second' }] })
  await expect(page.locator('.queued-item')).toHaveCount(2)
  await expect(page.locator('.queued-item').first()).toContainText('madetest first')
  await page.screenshot({ path: `test-results/queue-${info.project.name}.png` })

  // Taken back to the box.
  await page.locator('.queued-item').first().getByRole('button', { name: 'Take back to the box' }).click()
  await expect(box).toHaveValue('madetest first')
  await play({ type: 'queue', session: s.id, queue: [{ promptId: 'p2', text: 'madetest second' }] })
  await expect(page.locator('.queued-item')).toHaveCount(1)

  // A stop hands the rest back too.
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(box).toHaveValue('madetest first\n\nmadetest second')
  await play({ type: 'queue', session: s.id })
  await play({ type: 'turn', session: s.id, state: 'done' })
  await expect(page.locator('.queued-item')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await box.fill('')
  for (const r of ['send', 'unqueue/*', 'interrupt']) await page.unroute(`**/api/sessions/*/${r}`)
})

// Every tab has an icon (from a contributor's branch): sessions the agent's mark in
// Claude's orange, files their type (Material Icon Theme), unknown files a
// generic page, each drawn inside its box; the explorer's files too.
test('tabs and files carry icons', async ({ page }, info) => {
  const s = await openSession(page, (l) => l.filter((x) => x.provider !== 'codex')[0])
  const files = ['report.pdf', 'notes.md', 'letter.docx', 'main.go', 'App.tsx', 'fit.py', 'data.json', 'thesis.tex', 'odd.xyz'].map((f) => 'f:madetest-' + f)
  await seedTabs(page, s.folder!, { ids: [s.id, ...files], active: s.id })
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (!u.searchParams.get('path')?.startsWith('madetest-')) return route.fallback()
    return route.fulfill({ status: 404, body: 'not found' })
  })
  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  const tab = (id: string) => page.locator(`.tab[data-tab="${id}"]`)
  const mark = tab(s.id).locator('.agent-icon.claude')
  await expect(mark).toHaveCount(1)
  expect(await mark.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(217, 119, 87)')
  // Each file its own icon.
  const bodies = await Promise.all(files.map((id) => tab(id).locator('.file-icon').evaluate((el) => el.innerHTML)))
  expect(bodies.every((b) => b.includes('<path'))).toBe(true)
  expect(new Set(bodies).size).toBe(files.length)
  // And each is drawn inside its own box (Material's json icon sits at
  // top -960 and was once drawn off its box, blank).
  const inBox = await page.locator('.tab .file-icon, .tab .agent-icon').evaluateAll((els) =>
    els.map((el) => {
      const g = (el as SVGSVGElement).getBBox()
      const v = (el as SVGSVGElement).viewBox.baseVal
      return g.width > 0 && g.x < v.x + v.width && g.x + g.width > v.x && g.y < v.y + v.height && g.y + g.height > v.y
    }),
  )
  expect(inBox).toEqual(inBox.map(() => true))
  await page.screenshot({ path: `test-results/tab-icons-${info.project.name}.png` })
  if (info.project.name === 'desktop') {
    const rows = page.locator('.explorer-panel .tree-row:not(:has(.folder-icon))')
    await page.locator('.explorer-panel .tree-row').first().waitFor()
    if (await rows.count()) await expect(rows.first().locator('.file-icon')).toHaveCount(1)
  }
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

// On a laptop the bar between the explorer and the editor drags the
// explorer's width, which survives a reload; double-click resets it.
test('the explorer resizes by dragging', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  await openSession(page, (l) => l[0])
  const panel = page.locator('.explorer-panel')
  await panel.locator('.explorer [title]').first().waitFor() // laid out before measuring
  const w0 = (await panel.boundingBox())!.width
  const bar = (await page.locator('.splitter').boundingBox())!
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
  await page.mouse.down()
  await page.mouse.move(bar.x + 300, bar.y + bar.height / 2, { steps: 5 })
  await page.mouse.up()
  // Measured at once: the width must follow the mouse without waiting for
  // a render (a render per move used to lag, half the runs read 280 here).
  const w1 = (await panel.boundingBox())!.width
  expect(Math.abs(w1 - w0 - 300)).toBeLessThanOrEqual(4)
  // The narrower transcript re-wraps taller; it stays at the newest message.
  const gap = await page.locator('.transcript').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(gap).toBeLessThan(80)
  await page.screenshot({ path: 'test-results/explorer-resized.png' })

  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  expect(Math.abs((await panel.boundingBox())!.width - w1)).toBeLessThanOrEqual(1)
  await page.locator('.splitter').dblclick()
  expect(Math.abs((await panel.boundingBox())!.width - 280)).toBeLessThanOrEqual(1)

  // A narrower window re-wraps the transcript without a render; it still
  // stays at the newest message.
  await page.setViewportSize({ width: 920, height: 800 })
  await page.waitForTimeout(300)
  const after = await page.locator('.transcript').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(after).toBeLessThan(80)
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

// A table with one column of sentences, at phone width: the short columns
// stay on one line and the long one keeps a readable width, the table
// scrolling sideways instead. They were cut down to a word a line. The
// classes are mdrender.ts's (its unit test checks them); this checks what
// the CSS makes of them.
test('a table keeps its short columns whole on a phone', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone-webkit', 'the squeeze is worst on a phone')
  await page.goto('/login?token=' + token)
  const long = 'No good in-browser viewer exists. If LibreOffice is installed, the server can convert the file to PDF and show it in the PDF viewer.'
  const lines = await page.evaluate((long) => {
    const box = document.createElement('div')
    box.className = 'md'
    box.style.cssText = 'position:fixed;inset:0 16px auto;background:white;z-index:99'
    box.innerHTML =
      '<table><thead><tr><th class="short">Format</th><th class="long">Approach</th><th class="short">Effort</th></tr></thead>' +
      `<tbody><tr><td class="short">ODT, ODS, ODP, PowerPoint</td><td class="long">${long}</td><td class="short">Moderate, needs LibreOffice</td></tr></tbody></table>`
    document.body.append(box)
    const tops = (el: Element) => {
      const r = document.createRange()
      r.selectNodeContents(el)
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size
    }
    const [format, approach, effort] = [...box.querySelectorAll('td')]
    return { format: tops(format), effort: tops(effort), approach: approach.getBoundingClientRect().width / parseFloat(getComputedStyle(approach).fontSize) }
  }, long)
  expect(lines.format).toBe(1)
  expect(lines.effort).toBe(1)
  expect(lines.approach).toBeGreaterThanOrEqual(14)
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

// Background tasks that outlive their turn (agents, commands) show as
// work: a ring on the session's tab, not the turn's pulse, and the page
// icon's working look, where both once read as idle while agents ran.
test('background tasks after a turn still show as work', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const icon = page.locator('link[rel="icon"]')
  const tab = page.locator(`.tabs .tab[data-tab="${s.id}"]`)
  await expect(tab.locator('.dot.tasks')).toHaveCount(0)
  await play({ type: 'tasks', session: s.id, tasks: [{ id: 'k1', type: 'local_agent', description: 'Research' }] })
  await expect(tab.locator('.dot.tasks')).toHaveCount(1)
  await expect(tab.locator('.dot.run')).toHaveCount(0)
  await expect(icon).toHaveAttribute('data-state', 'run')
  await play({ type: 'tasks', session: s.id, tasks: [] })
  await expect(tab.locator('.dot.tasks')).toHaveCount(0)
  await expect(icon).toHaveAttribute('data-state', 'idle')
})

// The build shows under the folder list; a newer release replaces it once
// the server says so (a release event; the snapshot after a reconnect
// too): installing by itself once the server has started on it, else the
// line to run on the computer (the test server is not a release build, so
// it leaves updates to the person), so the phone learns of it without a
// terminal.
test('the version and a newer release show under the folder list', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  await openSession(page, (l) => l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const notice = page.locator('.notice.release')
  await expect(notice).toContainText('Dakort ')
  await expect(notice).not.toContainText('is out')
  await play({ type: 'release', latest: 'v9.9.9' })
  await expect(notice).toContainText('v9.9.9')
  await expect(notice).toContainText('is out')
  await expect(notice).toContainText('dakort update')
  await play({ type: 'release', latest: 'v9.9.9', update: 'v9.9.9' })
  await expect(notice).toContainText('installs itself once nothing is running')
  await play({ type: 'release', latest: 'v9.9.9' })
  await expect(notice).toContainText('dakort update')
})
