import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { closeOpened, openSession, seedTabs, tabsKey, token, opened, type Session } from './helpers'

test.skip(!token, 'DAKORT_TOKEN not set')
test.afterEach(closeOpened)

// The explorer lists newest first until Name is picked, remembered on the
// device. Folders come first either way.
test('the explorer sorts by date or by name', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  await page.addInitScript(() => localStorage.removeItem('dakort.filesSort'))
  // A session whose folder has files: the newest on 2026-11-21 was in an
  // empty folder, and the check waited for a row that never came.
  const list: Session[] = await (await page.request.get('/api/sessions', { headers: { Cookie: 'dakort_token=' + token } })).json()
  let pick: Session | undefined
  for (const s of list.slice(0, 20)) {
    const r = await page.request.get(`/api/files/list?root=${encodeURIComponent(s.folder ?? '')}&path=`, { headers: { Cookie: 'dakort_token=' + token } })
    if (r.ok() && ((await r.json()) as unknown[]).length) {
      pick = s
      break
    }
  }
  test.skip(!pick, 'no recent session in a folder with files')
  await openSession(page, (l) => l.find((s) => s.id === pick!.id) ?? l[0])
  const panel = page.locator('.explorer-panel')
  await panel.locator('.tree-row').first().waitFor()
  // The sort is an icon on the header's right with a menu of two orders.
  const sortBy = async (name: string) => {
    await panel.getByRole('button', { name: 'Sort', exact: true }).click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  const checked = async () => {
    await panel.getByRole('button', { name: 'Sort', exact: true }).click()
    const on = await page.locator('[role=menuitemradio][aria-checked=true]').textContent()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    return on
  }
  expect(await checked()).toBe('Recent')
  const files = () => panel.locator('.tree-row:not(:has(svg)) .ellipsis').allTextContents()
  await sortBy('Name')
  const named = await files()
  const lower = (s: string) => s.toLowerCase()
  expect(named).toEqual([...named].sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0))) // the server's order
  expect(await page.evaluate(() => localStorage.getItem('dakort.filesSort'))).toBe('name')
  await page.screenshot({ path: 'test-results/explorer-sort.png' })
  await sortBy('Recent')
  expect(await checked()).toBe('Recent')
})

// A right-click on a file asks before deleting it; Undo puts it back. The
// listing gets a made-up file and the delete and restore are caught, so
// nothing in the real project is touched (filetrash_test.go moves real
// files). A folder's right-click asks nothing.
test('a file is deleted from the explorer, with Undo', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone; a long press there, same code')
  const name = 'madetest-gone.txt'
  const entry = 'made-filetrash-1-0123456789abcdef'
  let deleted = false
  const asked: string[] = []
  await page.route(/\/api\/files\/list\?/, async (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== '') return route.fallback()
    const r = await route.fetch()
    const list = await r.json()
    return route.fulfill({ json: deleted ? list : [...list, { name, size: 5, mtime: new Date().toISOString() }] })
  })
  await page.route(/\/api\/files\/(delete|restore)/, (route) => {
    const u = new URL(route.request().url())
    if (u.pathname.endsWith('/delete')) {
      asked.push('delete ' + u.searchParams.get('path'))
      deleted = true
      return route.fulfill({ json: { trash: entry } })
    }
    asked.push('restore ' + route.request().postDataJSON().trash)
    deleted = false
    return route.fulfill({ json: { path: name } })
  })
  await openSession(page, (l) => l[0])
  const panel = page.locator('.explorer-panel')
  const row = panel.locator('.tree-row', { hasText: name })
  await row.click({ button: 'right' })
  const ask = page.getByRole('dialog', { name: `Delete ${name}` })
  await expect(ask).toContainText(`Delete ${name}?`)
  // Keep it: nothing is sent.
  await ask.getByRole('button', { name: 'Keep it' }).click()
  await expect(ask).toHaveCount(0)
  expect(asked).toEqual([])
  await row.click({ button: 'right' })
  await ask.getByRole('button', { name: 'Delete' }).click()
  await expect(page.locator('.toast')).toContainText(`Deleted ${name}`)
  await expect(row).toHaveCount(0)
  await page.screenshot({ path: 'test-results/explorer-deleted.png' })
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect(row).toHaveCount(1)
  expect(asked).toEqual(['delete ' + name, 'restore ' + entry])
  // A folder is not offered.
  const folder = panel.locator('.tree-row:has(.folder-icon)').first()
  if (await folder.count()) {
    await folder.click({ button: 'right' })
    await expect(ask).toHaveCount(0)
  }
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
  // Rows are 26 px, 32 on a touch screen (CsvView's rowH).
  const rowH = await table.locator('tbody td').first().evaluate((el) => Math.round(el.getBoundingClientRect().height))
  await box.evaluate((b, h) => (b.scrollTop = h * 3000), rowH)
  await expect(table.locator('tbody td', { hasText: 'Smith, row 3005' })).toBeVisible()
  const top = (await box.boundingBox())!.y
  expect(Math.abs((await table.locator('thead th').nth(1).boundingBox())!.y - top)).toBeLessThan(2)
  await page.screenshot({ path: `test-results/csv-${info.project.name}.png` })

  await page.locator('.file-head').getByRole('button', { name: 'Source' }).click()
  await expect(page.locator('.cm-content')).toContainText('id,name,amount')
  await page.locator('.file-head').getByRole('button', { name: 'Table' }).click()
  await expect(table).toBeVisible()
})

// A file bar's action: its button, or on a narrow screen the row of its ⋯
// menu that holds it.
async function headAct(page: Page, name: string) {
  const head = page.locator('.file-head')
  const b = head.getByRole('button', { name, exact: true })
  if (await b.isVisible()) return b.click()
  await head.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

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
  // (On a phone, while editing, Download is in the ⋯ menu.)
  await expect(touch ? head.getByRole('button', { name: 'More' }) : head.getByRole('link', { name: 'Download' })).toBeVisible()
  await content.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('added\n')
  await expect(head.locator('.crumb-dirty')).toHaveCount(1) // the unsaved dot
  await expect(head.getByRole('button', { name: touch ? 'More' : 'Revert' })).toBeVisible()
  await expect(head.getByRole('button', { name: 'Preview' })).toHaveCount(0) // the typing stays on screen
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0]).toEqual({ text: '# Notes\n\nfirst line\nadded\n', base: '"v1"' })
  await expect(head.locator('.crumb-dirty')).toHaveCount(0)
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
  // Revert asks first, in the app's own dialog (it was the browser's
  // confirm); the action has the focus, so Enter confirms.
  await headAct(page, touch ? 'Revert to the saved file' : 'Revert')
  const revertAsk = page.getByRole('alertdialog', { name: 'Revert to the saved file?' })
  await expect(revertAsk).toBeVisible()
  await expect(revertAsk.getByRole('button', { name: 'Revert' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(revertAsk).toHaveCount(0)
  await expect(content).not.toContainText('scrap')
  await expect(head.locator('.crumb-dirty')).toHaveCount(0)

  // On a phone, Done with unsaved typing asks first.
  if (touch) {
    await content.click()
    await page.keyboard.type('x')
    const discard = page.getByRole('alertdialog', { name: 'Discard your unsaved changes?' })
    await head.getByRole('button', { name: 'Done' }).click()
    await discard.getByRole('button', { name: 'Cancel' }).click()
    await expect(discard).toHaveCount(0)
    await expect(head.getByRole('button', { name: 'Done' })).toBeVisible()
    await head.getByRole('button', { name: 'Done' }).click()
    await discard.getByRole('button', { name: 'Discard' }).click()
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

// Preview and Source of a Markdown file meet at the same place: the block
// at the top of the preview is the line at the top of the editor; the
// editor's cursor line (or its top line) is the block at the top of the
// preview; and a file that changes under the preview keeps its block.
test('a Markdown file keeps its place between Preview and Source', async ({ page }) => {
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  const s = await openSession(page, (l) => l[0])
  const name = 'madetest-long.md'
  const lines: string[] = []
  for (let i = 1; i <= 60; i++) lines.push(`## Section ${i}`, '', `Paragraph ${i} text.`, '')
  let disk = { body: lines.join('\n'), mtime: '2026-11-16T00:00:00Z' }
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: disk.body.length, mtime: disk.mtime } })
    return route.fulfill({ body: disk.body, contentType: 'application/octet-stream', headers: { ETag: `"${disk.mtime}"` } })
  })
  const tab = 'f:' + name
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const md = page.locator('.file-md')
  const head = page.locator('.file-head')
  await expect(md).toContainText('Section 60')
  const atTop = async (line: number) => {
    const box = (await md.boundingBox())!
    const el = (await md.locator(`[data-line="${line}"]`).boundingBox())!
    expect(el.y - box.y).toBeGreaterThanOrEqual(0)
    expect(el.y - box.y).toBeLessThan(40)
  }
  const section40 = 157 // its heading's line
  await md.locator(`[data-line="${section40}"]`).evaluate((el) => el.scrollIntoView())
  await expect(md.locator('h2', { hasText: 'Section 40' })).toBeInViewport()
  await head.getByRole('button', { name: 'Source' }).click()
  await expect(page.locator('.cm-line', { hasText: /^## Section 40$/ })).toBeInViewport()
  await expect(page.locator('.cm-line', { hasText: /^## Section 1$/ })).not.toBeInViewport()
  await head.getByRole('button', { name: 'Preview' }).click()
  await atTop(section40)
  let top = section40
  if (!touch) {
    // The cursor, when on screen, says where the reader is.
    await head.getByRole('button', { name: 'Source' }).click()
    await page.locator('.cm-line', { hasText: /^## Section 40$/ }).click()
    await page.keyboard.press('PageDown')
    let text = ''
    for (let i = 0; i < 3 && !text; i++) {
      text = (await page.locator('.cm-activeLine').innerText()).trim()
      if (!text) await page.keyboard.press('ArrowDown') // off a blank line, to one that names its section
    }
    const k = Number(/\d+/.exec(text)![0])
    top = text.startsWith('##') ? 4 * (k - 1) + 1 : 4 * (k - 1) + 3
    expect(top).toBeGreaterThan(section40 + 10)
    await head.getByRole('button', { name: 'Preview' }).click()
    await atTop(top)
  }
  // The file grows above the reader: the block at the top stays.
  lines[2] = 'Paragraph 1 text, now long. ' + 'more words '.repeat(300)
  disk = { body: lines.join('\n'), mtime: '2026-11-16T00:01:00Z' }
  await expect(md).toContainText('now long', { timeout: 10_000 })
  await atTop(top)
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
  let fail = false
  const opened: string[] = []
  await page.route('**/api/here', (route) => route.fulfill({ json: { local } }))
  await page.route(/\/api\/files\/(stat|raw|open)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== 'madetest-report.html') return route.fallback()
    if (u.pathname.endsWith('/open')) {
      opened.push(u.searchParams.get('path')!)
      if (fail) return route.fulfill({ status: 500, json: { error: 'madetest: no browser here' } })
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

  // A failure is said under the bar in words, announced, with the reason
  // (on a phone the button is only an icon); Try again asks again.
  fail = true
  await page.locator('.file-head').getByRole('button', { name: 'Open in browser' }).click()
  const problem = page.getByRole('alert').filter({ hasText: 'Could not open madetest-report.html.' })
  await expect(problem).toContainText('madetest: no browser here')
  await expect(problem).toBeInViewport()
  fail = false
  await problem.getByRole('button', { name: 'Try again' }).click()
  await expect(problem).toHaveCount(0)
  expect(opened).toHaveLength(3)
})

// An OpenDocument spreadsheet is not shown (.xlsx is, see the Excel check):
// a note says to save it as .xlsx, and on the computer a button opens it
// in its program. Nothing of the file is fetched.
test('a spreadsheet says how to open it', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  let local = false
  const opened: string[] = []
  let fetched = 0
  await page.route('**/api/here', (route) => route.fulfill({ json: { local } }))
  await page.route(/\/api\/files\/(stat|raw|open)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== 'madetest-budget.ods') return route.fallback()
    if (u.pathname.endsWith('/open')) {
      opened.push('ods')
      return route.fulfill({ json: { ok: true } })
    }
    if (u.pathname.endsWith('/raw')) fetched++
    return route.fulfill({ json: { size: 4096, mtime: '2026-11-07T00:00:00Z' } })
  })
  const tab = 'f:madetest-budget.ods'
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const note = page.locator('.office-note')
  await expect(note).toContainText('does not show .ods files')
  await expect(note).toContainText('save it as .xlsx')
  await expect(page.locator('.file-head').getByRole('button', { name: 'Open on the computer' })).toHaveCount(0)

  local = true
  await page.reload()
  await page.locator('.file-head').getByRole('button', { name: 'Open on the computer' }).click()
  await expect.poll(() => opened).toEqual(['ods'])
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
  // From the keyboard too: a folder takes focus, Enter folds it, ← closes
  // it and Space opens it again. A file row takes no focus.
  await rows.nth(1).focus()
  await expect(rows.nth(1)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(rows).toHaveCount(3)
  await page.keyboard.press('ArrowRight')
  await expect(rows).toHaveCount(5)
  await page.keyboard.press('ArrowLeft')
  await expect(rows).toHaveCount(3)
  await page.keyboard.press(' ')
  await expect(rows).toHaveCount(5)
  await expect(rows.nth(2)).not.toHaveAttribute('tabindex')
  await rows.nth(0).click()
  await expect(rows).toHaveCount(1)
})

// An Excel file opens as a table per sheet with its fills, bold, text
// colours, merged cells, widths and number formats; hidden sheets stay
// hidden; a formula with no computed value is counted. The file is served
// by the test (e2e/sample.xlsx, from make_sample_xlsx.py).
test('an Excel file shows as formatted sheets', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const name = 'madetest-sample.xlsx'
  const body = readFileSync(new URL('sample.xlsx', import.meta.url))
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== name) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-11-16T00:00:00Z' } })
    return route.fulfill({ body, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  })
  const tab = 'f:' + name
  await seedTabs(page, s.folder!, { ids: [s.id, tab], active: tab })
  await page.reload()
  const table = page.locator('.sheet-table')
  await expect(table).toBeVisible()
  const cell = (r: number, c: number) => table.locator('tbody tr').nth(r - 1).locator('td').nth(c) // 0 is the row number
  // The merged title spans three columns, bold and centred.
  await expect(cell(1, 1)).toHaveText('Sample sheet')
  await expect(cell(1, 1)).toHaveAttribute('colspan', '3')
  await expect(cell(1, 1)).toHaveCSS('font-weight', '700')
  await expect(cell(1, 1)).toHaveCSS('text-align', 'center')
  // The header row's grey fill, a yellow cell, grey text.
  await expect(cell(2, 1)).toHaveText('Item')
  await expect(cell(2, 1)).toHaveCSS('background-color', 'rgb(217, 217, 217)')
  await expect(cell(3, 1)).toHaveCSS('background-color', 'rgb(255, 242, 204)')
  await expect(cell(4, 1)).toHaveCSS('color', 'rgb(128, 128, 128)')
  // Number, percent and date formats; numbers right-aligned.
  await expect(cell(3, 2)).toHaveText('1,234.50')
  await expect(cell(3, 2)).toHaveCSS('text-align', 'right')
  await expect(cell(3, 3)).toHaveText('13%')
  await expect(cell(3, 4)).toHaveText('2026-11-16')
  await expect(cell(5, 2)).toHaveText('0.75')
  // The formula openpyxl wrote has no result: blank, and said so.
  await expect(cell(6, 2)).toHaveText('')
  await expect(page.locator('.sheet-foot')).toContainText('1 formula cell has no computed value')
  // Column A is wider than C, as set.
  const a = (await table.locator('thead th').nth(1).boundingBox())!
  const c = (await table.locator('thead th').nth(3).boundingBox())!
  expect(a.width).toBeGreaterThan(c.width * 1.3)
  await page.screenshot({ path: `test-results/xlsx-${info.project.name}.png` })
  // Two visible sheets; the hidden one is not offered.
  const tabs = page.locator('.sheet-tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs).toHaveText(['Data', 'Notes'])
  await tabs.nth(1).click()
  await expect(cell(1, 1)).toHaveText('A second sheet')
  await expect(page.locator('.sheet-foot')).toContainText('2 rows × 1 column')
  // The head has the path and the computer's Open button, no Source toggle.
  await expect(page.locator('.file-head')).toContainText(name)
  await expect(page.locator('.file-head').getByRole('button', { name: 'Source' })).toHaveCount(0)
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
  // On a phone zoom is in the ⋯ menu.
  const zoomIn = async () => {
    if (await bar.getByRole('button', { name: 'Zoom in' }).isVisible()) return bar.getByRole('button', { name: 'Zoom in' }).click()
    await bar.getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Zoom in' }).click()
  }
  await zoomIn()
  await zoomIn()
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
  await expect(page.locator('.pdf-find')).toContainText('No matches')
  await box.press('Escape')
  await expect(page.locator('.pdf-find')).toHaveCount(0)
  await expect(page.locator('.pdf-hit')).toHaveCount(0)
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
  await page.getByRole('button', { name: 'Hide the sidebar', exact: true }).click()
  await page.reload()
  await expect(page.locator('.explorer-panel')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  const other = page.locator('.folder-list .folder-row:not(.on):not(.more)').first()
  await other.click()
  await page.waitForURL((u) => !decodeURIComponent(u.hash).endsWith(s.folder!))
  await expect(page.locator('.explorer-panel')).toHaveCount(1)
})

// On a phone, opening a file closes the drawer; opened again, the folder
// it came from is still open (it used to start over, every folder shut).
// The folder and its file are served by the test.
test('the phone drawer keeps its open folders after a file opens', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop', 'the explorer stays shown on a laptop')
  const dir = 'madetest-deep'
  const name = dir + '/madetest-notes.md'
  await page.route(/\/api\/files\/list\?/, async (route) => {
    const p = new URL(route.request().url()).searchParams.get('path')
    if (p === dir) return route.fulfill({ json: [{ name: 'madetest-notes.md', size: 10, mtime: new Date().toISOString() }] })
    if (p !== '') return route.fallback()
    const list = await (await route.fetch()).json()
    return route.fulfill({ json: [{ name: dir, dir: true, size: 0, mtime: new Date().toISOString() }, ...list] })
  })
  await serveNotes(page, name)
  await openSession(page, (l) => l[0])
  await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  const panel = page.locator('.explorer-panel')
  await panel.locator('.tree-row', { hasText: dir }).click()
  await panel.locator('.tree-row', { hasText: 'madetest-notes.md' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: 'Show the sidebar', exact: true }).click()
  await expect(panel.locator('.tree-row', { hasText: 'madetest-notes.md' })).toBeVisible()
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
    // The listing, or the word that the folder is empty (the newest
    // session's folder was, on 2026-11-21, and this waited for good).
    await page.locator('.explorer-panel .tree-row, .explorer-panel .explorer > .faint').first().waitFor()
    if (await rows.count()) await expect(rows.first().locator('.file-icon')).toHaveCount(1)
  }
})

// On a laptop the bar between the explorer and the editor drags the
// explorer's width, which survives a reload; double-click resets it.
test('the explorer resizes by dragging', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the explorer is a drawer on a phone')
  await openSession(page, (l) => l[0])
  const panel = page.locator('.explorer-panel')
  await panel.locator('.explorer .tree-row').first().waitFor() // laid out before measuring
  const w0 = (await panel.boundingBox())!.width
  const bar = (await page.locator('.splitter').boundingBox())!
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2)
  await page.mouse.down()
  // 300 px from where it was taken (the bar is wider than it was).
  await page.mouse.move(bar.x + bar.width / 2 + 300, bar.y + bar.height / 2, { steps: 5 })
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

// On a phone the bars over a file are one row of 44 px buttons, none of
// them within 8 px of the screen's edge, and the path gives way instead:
// a long path keeps the file's name, and the whole path is in its tip.
// The PDF's bar too, where the page count and "Fit page" once wrapped onto
// two lines each.
test("a file's toolbar keeps its buttons whole and on screen on a phone", async ({ page }) => {
  test.skip(!(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)), 'touch targets are a phone question')
  const s = await openSession(page, (l) => l[0])
  const md = 'madetest-folder/madetest-a-rather-long-folder-name/madetest-notes.md'
  const pdf = 'madetest-sample.pdf'
  const pdfBody = readFileSync(new URL('sample.pdf', import.meta.url))
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    const p = u.searchParams.get('path')
    const body = p === md ? '# Notes\n\nfirst line\n' : p === pdf ? pdfBody : null
    if (body === null) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-11-20T00:00:00Z', complete: true } })
    return route.fulfill({ body, contentType: p === pdf ? 'application/pdf' : 'application/octet-stream', headers: { ETag: '"m"' } })
  })
  const check = async (bar: string, names: string[]) => {
    const vw = page.viewportSize()!.width
    const boxes = []
    for (const n of names) {
      const b = (await page.locator(bar).getByRole(n === 'Download' ? 'link' : 'button', { name: n, exact: true }).boundingBox())!
      expect(b.width, n).toBeGreaterThanOrEqual(44)
      expect(b.height, n).toBeGreaterThanOrEqual(44)
      expect(b.x, n).toBeGreaterThanOrEqual(8)
      expect(b.x + b.width, n).toBeLessThanOrEqual(vw - 8)
      boxes.push(b)
    }
    // One row: every button on the same line.
    expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1)
  }

  await seedTabs(page, s.folder!, { ids: [s.id, 'f:' + md], active: 'f:' + md })
  await page.reload()
  await expect(page.locator('.file-md')).toContainText('first line')
  await check('.file-head', ['Edit', 'Source', 'Download'])
  const crumb = page.locator('.file-head .crumb')
  await expect(crumb).toHaveAttribute('data-tip', md)
  // The name is whole; the folders gave way.
  expect(await crumb.locator('.crumb-name').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.locator('.file-head').getByRole('button', { name: 'Source' }).click()
  // Beside the switch, Find and Download are in the ⋯ menu on a phone.
  await check('.file-head', ['Edit', 'Preview', 'More'])
  // Find in the source: the same one-row bar as a PDF's, its box 16 px
  // (iOS zooms on less).
  await expect(page.locator('.cm-content')).toContainText('first line')
  await headAct(page, 'Find')
  await expect(page.locator('.code-find input')).toBeFocused()
  expect(await page.locator('.code-find input').evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await page.keyboard.type('line')
  await page.keyboard.press('Enter')
  await expect(page.locator('.code-find .find-count')).toHaveText('1 / 1')
  // The box has the first row to itself but for close; the rest below.
  await check('.code-find', ['Match case', 'Whole words', 'Previous match', 'Next match'])
  await check('.code-find', ['Close find'])
  expect((await page.locator('.code-find input').boundingBox())!.width).toBeGreaterThan(250)

  await seedTabs(page, s.folder!, { ids: [s.id, 'f:' + pdf], active: 'f:' + pdf })
  await page.reload()
  await expect(page.locator('.pdf-page')).toHaveCount(3)
  // Download and Source are in the ⋯ menu on a phone, so the name has room
  // beside Find and zoom; the page count floats over the pages.
  await check('.pdf-bar', ['Find', 'Zoom out', 'Fit page', 'Zoom in', 'More'])
  // Room for a name of a dozen characters or more (this one has 19).
  expect(await page.locator('.pdf-bar .crumb-name').evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(100)
  await expect(page.locator('.pdf-count-float')).toHaveText('p. 1 / 3')
  await page.locator('.pdf-bar').getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible()
  // Picking a spot from the menu says so, with a way out.
  await page.getByRole('menuitem', { name: 'Source: tap a spot' }).click()
  await expect(page.locator('.sync-note')).toContainText('Tap a spot')
  await page.locator('.sync-note').getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.sync-note')).toHaveCount(0)
  const count = (await page.locator('.pdf-count-float').boundingBox())!
  expect(count.height).toBeLessThan(30) // "1 / 3" on one line (a pill with its padding)
})

// On a phone a Word file at Fit and a CSV wider than the screen scroll no
// further than their content: the Word page was scaled with a transform
// that left its unscaled width as scroll room (476 px of empty grey), and
// a CSV's last column took all the spare width (636 px of blank cells
// under no header).
test('a Word file at Fit and a wide CSV scroll no further than their content on a phone', async ({ page }) => {
  test.skip(!(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)), 'a phone question')
  const s = await openSession(page, (l) => l[0])
  const docx = 'madetest-sample.docx'
  const csv = 'madetest-wide.csv'
  const docxBody = readFileSync(new URL('sample.docx', import.meta.url))
  const note = 'a long note that runs on well past the width of any phone screen, and then some more words'
  const csvBody = 'id,customer,region,notes\n1,Acme Tools,North,' + note + '\n2,Birch Labs,South,ok\n'
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    const p = u.searchParams.get('path')
    const body = p === docx ? docxBody : p === csv ? csvBody : null
    if (body === null) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-11-20T00:00:00Z' } })
    return route.fulfill({ body, contentType: 'application/octet-stream' })
  })
  await seedTabs(page, s.folder!, { ids: [s.id, 'f:' + docx], active: 'f:' + docx })
  await page.reload()
  await page.locator('.file-docx section.docx').first().waitFor()
  await expect.poll(() => page.locator('.file-docx').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

  await seedTabs(page, s.folder!, { ids: [s.id, 'f:' + csv], active: 'f:' + csv })
  await page.reload()
  const box = page.locator('.csv-box')
  await expect(box.locator('tbody tr')).toHaveCount(2)
  const m = await box.evaluate((el) => {
    const t = el.querySelector('table')!.getBoundingClientRect()
    const ths = [...el.querySelectorAll('thead th')].map((th) => th.getBoundingClientRect())
    return { scroll: el.scrollWidth, table: Math.round(t.width), last: Math.round(ths.at(-1)!.width), fits: [...el.querySelectorAll('tbody tr:first-child td')].slice(0, 4).every((td) => td.scrollWidth <= td.clientWidth) }
  })
  expect(m.scroll).toBeLessThanOrEqual(m.table + 1) // nothing past the table
  expect(m.last).toBeLessThan(page.viewportSize()!.width) // no column wider than the screen
  expect(m.fits).toBe(true) // the short cells are whole: the row number, id, customer and region

  // On a 360 px phone, swiped to the end: no column starts under the pinned
  // row numbers (a column capped at 42 characters once began 28 px under
  // them, its header reading 'tes').
  await page.setViewportSize({ width: 360, height: 780 })
  await box.evaluate((el) => (el.scrollLeft = el.scrollWidth))
  await page.waitForTimeout(200)
  const end = await box.evaluate((el) => {
    const rn = el.querySelector('thead th.rn')!.getBoundingClientRect()
    const ths = [...el.querySelectorAll('thead th:not(.rn)')].map((th) => th.getBoundingClientRect())
    // The last column's start, and the widest column against the room beside the row numbers.
    return { gap: ths.at(-1)!.left - rn.right, widest: Math.max(...ths.map((r) => r.width)), room: el.clientWidth - rn.width }
  })
  expect(end.gap).toBeGreaterThanOrEqual(0)
  expect(end.widest).toBeLessThanOrEqual(end.room)
})

// A CSV cell cut short by its column shows its whole text on a tap (a
// phone shows no title).
test('a cut CSV cell shows its whole text on a tap', async ({ page }) => {
  test.skip(!(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)), 'a phone question')
  const s = await openSession(page, (l) => l[0])
  const csv = 'madetest-cut.csv'
  const note = 'Asked for an invoice in EUR and a second seat for the new hire next month'
  const body = 'id,notes,active_customers_at_end_of_week_after_churn\n1,' + note + ',120\n2,ok,95\n'
  await page.route(/\/api\/files\/(stat|raw)\?/, (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.get('path') !== csv) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: body.length, mtime: '2026-11-20T00:00:00Z' } })
    return route.fulfill({ body, contentType: 'text/csv' })
  })
  await page.setViewportSize({ width: 360, height: 780 })
  await seedTabs(page, s.folder!, { ids: [s.id, 'f:' + csv], active: 'f:' + csv })
  await page.reload()
  const cut = page.locator('.csv-table tbody td', { hasText: 'Asked for' })
  await expect(cut).toHaveAttribute('data-tip-tap', '')
  await expect(page.locator('.csv-table tbody td', { hasText: /^ok$/ })).not.toHaveAttribute('data-tip')
  await cut.tap()
  await expect(page.locator('.tip[data-open]')).toContainText(note)
  // A long header over short numbers: the column is sized by its numbers,
  // the header cut with its tap-to-read (it was a 328 px column).
  const long = page.locator('.csv-table thead th', { hasText: 'active_customers' })
  expect((await long.boundingBox())!.width).toBeLessThan(150)
  await expect(long).toHaveAttribute('data-tip-tap', '')
})
