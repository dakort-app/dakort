import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeOpened, openSession, seedTabs, quiet, token, type Session } from './helpers'

test.skip(!token, 'DAKORT_TOKEN not set')
test.afterEach(closeOpened)

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
      // By its bottom: older rows of the same reply land inside it, above
      // what was on screen (its time label goes, it grows at the top).
      const top = first.getBoundingClientRect().bottom
      for (let i = 0; i < 40 && el.querySelectorAll('[data-anchor]').length === before; i++) await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 300))
      const same = el.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(key)}"]`)
      return {
        before,
        after: el.querySelectorAll('[data-anchor]').length,
        moved: same ? same.getBoundingClientRect().bottom - top : null,
      }
    }, step % 2 === 1)
    console.log(`older page ${step + 1} (${step % 2 ? '1.5 screens down' : 'top'}): ${r.before} -> ${r.after} items, anchor moved ${r.moved} px`)
    if (r.after === r.before) break // reached the start
    expect(r.moved).not.toBeNull()
    expect(Math.abs(r.moved!)).toBeLessThanOrEqual(2)
  }
})

// The mode chip offers VS Code's four modes plus Bypass, and shows the mode
// the session's transcript says it last ran with (a terminal's "auto" once
// came up as the global default, "Ask before edits"). A quiet session whose
// last mode the list found: the index reads 4 MB back for it (usedMax), and
// on 2026-11-21 the pick's last typed message sat 9.7 MB before the end,
// one long turn later, so the chip rightly fell back to Auto.
test('the mode chip shows what the session last ran with', async ({ page }) => {
  const s = await openSession(page, (l) => quiet(l.filter((x) => x.used?.mode).length ? l.filter((x) => x.used?.mode) : l))
  const tail: { rows: { role: string; permissionMode?: string }[] } = await (await page.request.get(`/api/sessions/${s.id}/rows?n=200`)).json()
  const last = tail.rows.filter((r) => r.role === 'user' && r.permissionMode).pop()?.permissionMode
  const chip = page.locator('.composer .mode-chip')
  const names: Record<string, string> = { default: 'Manual', manual: 'Manual', acceptEdits: 'Edit automatically', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass permissions', dontAsk: "Don't ask" }
  // Its menu names each mode with what it does, the one in use ticked.
  await chip.click()
  const rows = page.locator('.mode-menu .picker-panel [role=option]')
  expect(await rows.locator('.opt-label').allTextContents()).toEqual(
    last === 'dontAsk'
      ? ['Manual', 'Edit automatically', 'Plan', 'Auto', 'Bypass permissions', "Don't ask"]
      : ['Manual', 'Edit automatically', 'Plan', 'Auto', 'Bypass permissions'],
  )
  for (const d of await rows.locator('.opt-desc').allTextContents()) expect(d).toMatch(/^(Claude|Codex) .{10,}/)
  const on = (await page.locator('.mode-menu [role=option][aria-selected=true] .opt-label').textContent())!
  if (last) expect(on).toBe(names[last])
  await page.keyboard.press('Escape')
  await expect(page.locator('.mode-menu .picker-panel')).toHaveCount(0)
  console.log(`last mode in the transcript: ${last ?? '(none)'}; chip: ${on}`)
  // As wide as the mode's name, not the longest option ("Bypass permissions").
  if (on === 'Auto') expect((await chip.boundingBox())!.width).toBeLessThan(80)

  // And the model chip: the last reply's model, not the global default.
  const list: { id: string; used?: { model?: string } }[] = await (await page.request.get('/api/sessions')).json()
  const model = list.find((x) => x.id === s.id)?.used?.model
  // The names are the CLI's own (the list the page shows), so a new model
  // on this machine needs no change here; an id the list lacks shows as is.
  const cfg = await (await page.request.get('/api/config')).json()
  const labels: Record<string, string> = Object.fromEntries((cfg.claude?.models ?? []).map((m: { full: string; label: string }) => [m.full, m.label]))
  if (model) await expect(page.locator('.composer .chip-btn')).toContainText(labels[model.replace(/\[.*$/, '')] ?? model)
  console.log(`last model: ${model ?? '(none)'}; chip: ${await page.locator('.composer .chip-btn').textContent()}`)

  // A tap on the cache clock explains the cache, in the app's tooltip; the
  // session's idle-compaction switch is in the model menu with its other
  // settings.
  const clock = page.locator('.cache-clock')
  if (await clock.count()) {
    await clock.click()
    await expect(page.locator('.tip[data-open]')).toContainText(/cache (warm|cold)/)
    await expect(page.getByRole('switch', { name: 'Compact when idle' })).toHaveCount(0)
    await clock.click()
    await expect(page.locator('.tip[data-open]')).toHaveCount(0)
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

// An image is a small thumbnail; a click shows it large in a popup that a
// click anywhere, or Escape, closes (it used to open a new browser tab).
// A 4K screenshot pasted shows at once and goes out as a PNG Claude takes
// whole (2576 px, 3.75 MP), even when Send comes before it has shrunk. The
// send is caught here and refused, so no CLI runs: the image comes back.
// Files dropped on the transcript attach as + does; a veil shows while
// they are over the session. An image goes with the message; any other
// file is uploaded to the project folder and its path, as the server
// named it, goes in the box. The upload is caught here, so nothing is
// written into a real project.
test('files dropped on a session: images attach, other files upload', async ({ page }) => {
  const s = await openSession(page, (l) => l[0])
  // (A File body is not visible to a route; upload_test.go checks the bytes.)
  let upload: { url: URL; type: string } | null = null
  await page.route('**/api/files/upload?**', async (route) => {
    upload = { url: new URL(route.request().url()), type: (await route.request().allHeaders())['content-type'] }
    return route.fulfill({ json: { path: 'notes (2).txt' } })
  })
  const box = page.locator('.composer textarea')
  await box.fill('madetest: read')
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
  await expect(box).toHaveValue('madetest: read `notes (2).txt` ')
  expect(upload).not.toBeNull()
  const u = upload!
  expect(u.url.searchParams.get('root')).toBe(s.folder)
  expect(u.url.searchParams.get('name')).toBe('notes.txt')
  expect(u.type).toBe('application/octet-stream')
  await expect(page.locator('.composer .notice.error')).toHaveCount(0)
  await page.locator('.composer .attachment .tab-x').click()
  await box.fill('')
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
  // Effort is a compact menu on its row: its button says the pick.
  const effort = page.locator('.picker-panel .picker-page.on .effort-select')
  const pickEffort = async (name: string) => {
    await effort.click()
    // (Default's row also names what it stands for: "Default High".)
    await page.getByRole('menuitemradio', name === 'Default' ? { name: /^Default/ } : { name, exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  const chrome = page.locator('.picker-panel [role=switch][aria-label=Chrome]')
  await page.locator('.composer .chip-btn').click()
  await pickEffort('Low')
  await expect(effort).toHaveText('Low')
  await chrome.click()
  await expect(chrome).toHaveAttribute('aria-checked', 'true')
  await page.waitForTimeout(500) // the post
  await page.reload()
  await expect(page.locator('.composer .chip-btn .chip-chrome')).toBeVisible()
  await page.locator('.composer .chip-btn').click()
  await expect(effort).toHaveText('Low')
  await expect(chrome).toHaveAttribute('aria-checked', 'true')
  await chrome.click()
  await expect(chrome).toHaveAttribute('aria-checked', 'false')
  await pickEffort('Default')
  await expect(effort).toHaveText('Default')
})

// A new session's pane mounts a fresh composer before the session list
// knows the session; it showed the default model (Opus) though the turn
// ran the pick. The send is answered here, so no CLI runs.
test('a new session keeps the model it was sent with', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dakort.provider', 'claude'))
  await openSession(page, (l) => l.filter((x) => x.provider !== 'codex' && !x.heldBy && x.size > 50_000).sort((a, b) => a.size - b.size)[0])
  const fake = '00000000-0000-4000-8000-00000000f4b1'
  await page.route('**/api/sessions', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ json: { session: fake, promptId: route.request().postDataJSON().promptId } }) : route.fallback(),
  )
  await page.locator('button[aria-label="New session"]').first().click()
  const chip = page.locator('.composer .model-menu .chip-btn')
  await chip.click()
  await page.locator('.picker-panel .picker-page.on .picker-row', { hasText: 'Fable' }).click()
  await page.keyboard.press('Escape')
  await expect(chip).toContainText('Fable')
  await page.locator('.composer textarea').fill('hello')
  await page.locator('.composer textarea').press('Enter')
  await page.waitForTimeout(1000)
  await expect(chip).toContainText('Fable')
})

// A Codex thread reads like a Claude session: prompts, replies, tool rows,
// and OpenAI's mark on the model chip with GPT models in the picker; no
// prompt-cache clock (Claude's), no slash menu.
test('a Codex session shows its rows and its own picker', async ({ page }, info) => {
  const sessions: Session[] = await (await page.request.get('/api/sessions', { headers: { Cookie: 'dakort_token=' + token } })).json()
  test.skip(!sessions.some((s) => s.provider === 'codex' && s.folder), 'no Codex session on this machine')
  const s = await openSession(page, (l) => l.filter((x) => x.provider === 'codex').sort((a, b) => b.size - a.size)[0])
  console.log(`codex session: ${s.title} (${(s.size / 1e6).toFixed(1)} MB)`)
  await expect(page.locator('.transcript .reply').first()).toBeVisible()
  await expect(page.locator('.composer .model-menu .chip-btn .agent-icon.codex')).toHaveCount(1)
  await expect(page.locator('.composer .cache-clock')).toHaveCount(0)
  await page.locator('.composer .chip-btn').click()
  await expect(page.locator('.picker-panel .picker-page.on .picker-row', { hasText: /GPT/ }).first()).toBeVisible()
  await expect(page.locator('.picker-panel', { hasText: 'Ultracode' })).toHaveCount(0)
  await expect(page.locator('.picker-panel [aria-label=Chrome]')).toHaveCount(0)
  await page.screenshot({ path: `test-results/codex-${info.project.name}.png` })
  await page.keyboard.press('Escape')
  await page.locator('.composer textarea').fill('/')
  await expect(page.locator('.slash-menu')).toHaveCount(0)
  await page.locator('.composer textarea').fill('')
})

// The model menu: one panel for Claude and Codex. Sends are caught here
// and never reach a CLI.
async function noSends(page: Page) {
  const hits: string[] = []
  await page.route(/\/api\/sessions(\/[^/]+\/send)?$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    hits.push(route.request().url())
    return route.fulfill({ status: 500, body: 'madetest: no sends' })
  })
  return hits
}
type Config = { codex?: { models: { id: string; label: string }[] } }
const config = async (page: Page): Promise<Config> => (await page.request.get('/api/config')).json()

// The model menu's parts, in a pane (or the page).
const menu = (at: Page | Locator) => {
  const root = at.locator('.composer .model-menu')
  return {
    chip: root.locator('.chip-btn'),
    panel: root.locator('.picker-panel'),
    tab: (p: string) => root.locator(`.picker-tab[data-agent=${p}]`),
    page: (p: string) => root.locator(`.picker-page[data-agent=${p}]`),
    shown: root.locator('.picker-page.on'),
  }
}
// The panel fades in and rises: where it ends up is measured after.
const risen = (panel: Locator) => panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => {}))
// A Claude session of some size nothing is writing to.
const settled = (l: Session[]) => l.filter((x) => x.provider !== 'codex' && !x.heldBy).sort((a, b) => a.size - b.size).find((x) => x.size > 100_000) ?? l[0]

// The folder's new-session tab, the only place the agent is chosen.
async function openNew(page: Page) {
  const s = await openSession(page, settled)
  await seedTabs(page, s.folder!, { ids: ['new'], active: 'new' })
  await page.reload()
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', 'new')
  await page.locator('.composer textarea').waitFor()
  return s
}

// The panel is as tall as its taller page, whichever is on show (so it
// never jumps as the page turns), and scrolls only at its max height.
async function fitsItsPage(panel: Locator) {
  const fit = await panel.evaluate((el) => {
    el.scrollTop = 0
    const pages = [...el.querySelectorAll('.picker-page')].map((p) => p.getBoundingClientRect().height)
    const shown = el.querySelector('.picker-page.on')!.getBoundingClientRect().height
    const cs = getComputedStyle(el)
    return { tallest: Math.max(...pages), shown, scrolls: el.scrollHeight > el.clientHeight + 1, max: parseFloat(cs.maxHeight), h: el.getBoundingClientRect().height }
  })
  expect(Math.abs(fit.shown - fit.tallest)).toBeLessThan(1)
  if (fit.scrolls) expect(fit.h).toBeGreaterThanOrEqual(fit.max - 2) // scrolls only at its max
}

// A new session's menu turns between Claude and Codex.
test('the model menu turns between Claude and Codex', async ({ page }, info) => {
  const sends = await noSends(page)
  await page.addInitScript(() => localStorage.setItem('dakort.provider', 'claude'))
  await openNew(page)
  const cfg = await config(page)
  const m = menu(page)
  await expect(m.chip.locator('.agent-icon.claude')).toHaveCount(1)
  await expect(page.locator('.composer select[aria-label=Agent]')).toHaveCount(0) // no separate agent chooser
  const before = await m.chip.textContent()
  await m.chip.click()
  // The switch: two tabs with the marks, Claude's on, its page on show.
  await expect(m.panel.locator('[role=tablist] [role=tab]')).toHaveCount(2)
  await expect(m.tab('claude').locator('.agent-icon.claude')).toHaveCount(1)
  await expect(m.tab('codex').locator('.agent-icon.codex')).toHaveCount(1)
  await expect(m.tab('claude')).toHaveAttribute('aria-selected', 'true')
  await expect(m.page('codex')).toBeHidden()
  await expect(m.shown).toHaveAttribute('data-agent', 'claude')
  await expect(m.shown.locator('[role=option][aria-selected=true]')).toHaveCount(1)
  // The session's settings, all in this panel: Effort as a compact menu
  // on its row, Chrome; no Ultracode (review of 2026-11-24).
  await expect(m.shown.locator('.effort-select')).toHaveText('Default')
  await expect(m.shown.getByRole('switch', { name: 'Chrome', exact: true })).toBeVisible()
  await expect(m.shown.getByRole('switch', { name: 'Ultracode' })).toHaveCount(0)
  await expect(m.shown.getByRole('switch', { name: 'Compact when idle' })).toHaveCount(0) // nothing to compact yet
  await fitsItsPage(m.panel)
  await page.screenshot({ path: `test-results/model-menu-${info.project.name}-claude.png` })
  await risen(m.panel)
  const tabsAt = (await m.tab('codex').boundingBox())!
  const heightAt = (await m.panel.boundingBox())!.height

  // Codex's tab: its page, no check, the same layout with the settings
  // that apply to Codex (Effort, no switches); turning picks nothing.
  await m.tab('codex').click()
  await expect(m.tab('codex')).toHaveAttribute('aria-selected', 'true')
  await expect(m.page('claude')).toBeHidden()
  await expect(m.shown).toHaveAttribute('data-agent', 'codex')
  if (cfg.codex?.models.length) await expect(m.shown.locator('.effort-select')).toHaveCount(1)
  await expect(m.shown.getByRole('switch')).toHaveCount(0)
  await expect(m.chip).toHaveText(before!)
  // No shift: the switch stays put and the panel keeps its height, at
  // once and a second later, with the pointer moved away too.
  expect(Math.round((await m.tab('codex').boundingBox())!.y)).toBe(Math.round(tabsAt.y))
  await page.mouse.move(tabsAt.x + tabsAt.width / 2, tabsAt.y + 200)
  await page.waitForTimeout(1000)
  expect(Math.round((await m.panel.boundingBox())!.height)).toBe(Math.round(heightAt))
  await fitsItsPage(m.panel)
  if (cfg.codex?.models.length) {
    // The newest of each family first, the rest behind More models.
    const more = m.shown.getByRole('button', { name: /^More models/ })
    if (await more.count()) await more.click()
    await expect(m.shown.locator('[role=option]')).toHaveCount(cfg.codex.models.length + 1)
    await expect(m.shown.locator('[role=option][aria-selected=true]')).toHaveCount(0)
    await expect(m.shown).not.toContainText('Opens a new') // a pick switches this session, in place
  } else {
    await expect(m.shown.locator('.picker-off')).toBeVisible()
  }
  await page.screenshot({ path: `test-results/model-menu-${info.project.name}-codex.png` })
  // Scrolled to the end (a phone's panel scrolls): the switch stays on top
  // (under the grab bar and the sheet's header on a phone).
  await m.panel.evaluate((el) => (el.scrollTop = el.scrollHeight))
  expect((await m.tab('codex').boundingBox())!.y - (await m.panel.boundingBox())!.y).toBeLessThan(info.project.name === 'desktop' ? 16 : 80)
  await page.keyboard.press('Escape')
  await expect(m.panel).toHaveCount(0)
  // Reopened: back on the session's own page.
  await m.chip.click()
  await expect(m.shown).toHaveAttribute('data-agent', 'claude')
  await page.keyboard.press('Escape')

  // Keyboard: opened from the chip the focus is on the model in use; Right
  // turns the page and focuses its tab, Down goes into its list, Left back.
  await m.chip.focus()
  await page.keyboard.press('ArrowDown')
  await expect(m.page('claude').locator('[role=option][aria-selected=true]')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(m.tab('codex')).toBeFocused()
  await expect(m.shown).toHaveAttribute('data-agent', 'codex')
  if (cfg.codex?.models.length) {
    await page.keyboard.press('ArrowDown')
    await expect(m.page('codex').locator('[role=option]').first()).toBeFocused()
  }
  await page.keyboard.press('ArrowLeft')
  await expect(m.tab('claude')).toBeFocused()
  await expect(m.shown).toHaveAttribute('data-agent', 'claude')
  await page.keyboard.press('Escape')
  await expect(m.panel).toHaveCount(0)
  await expect(m.chip).toBeFocused()
  await expect(m.chip).toHaveText(before!)
  // A tap outside closes it (on a phone, on the dimmed page over it).
  await m.chip.click()
  // (The panel sits over the text field's left part, by its chip: the
  // click goes to the field's right end, outside it.)
  if (info.project.name === 'desktop') {
    const field = (await page.locator('.composer textarea').boundingBox())!
    await page.locator('.composer textarea').click({ position: { x: field.width - 24, y: field.height / 2 } })
  }
  else await page.locator('.menu-scrim').click({ position: { x: 20, y: 20 } })
  await expect(m.panel).toHaveCount(0)
  expect(sends).toEqual([])
})

// Codex not installed, or installed and listing no models (signed out):
// its page stays, with the hint in place of the models.
// A page stays open for days, and a CLI update brings a model it has not
// seen: the menu asks for the list again as it opens, so the model is
// there without a reload. Nothing is sent.
test('a model the CLI gains shows in an open page', async ({ page }) => {
  const sends = await noSends(page)
  let gained = false
  let asks = 0
  await page.route('**/api/config', async (route) => {
    asks++
    const res = await route.fetch()
    const c = await res.json()
    if (gained && c.claude?.models) c.claude.models = [...c.claude.models, { id: 'madetest', full: 'claude-madetest-9', label: 'Madetest 9', desc: 'Not a model' }]
    await route.fulfill({ response: res, json: c })
  })
  await page.addInitScript(() => localStorage.setItem('dakort.provider', 'claude'))
  await openNew(page)
  const m = menu(page)
  await expect(m.chip).toBeVisible()
  const before = asks
  gained = true
  await m.chip.click()
  await expect(m.shown.getByRole('option', { name: /Madetest 9/ })).toBeVisible()
  expect(asks).toBe(before + 1)
  // Opening again within the minute asks nothing more.
  await page.keyboard.press('Escape')
  await m.chip.click()
  await expect(m.shown.getByRole('option', { name: /Madetest 9/ })).toBeVisible()
  expect(asks).toBe(before + 1)
  expect(sends).toEqual([])
})

test('the model menu says how to get Codex when it is missing or signed out', async ({ page }, info) => {
  const sends = await noSends(page)
  let installed = false
  await page.route('**/api/config', async (route) => {
    const res = await route.fetch()
    const c = await res.json()
    c.clis = (c.clis ?? []).map((x: { name: string }) => (x.name === 'codex' ? { ...x, found: installed, install: 'npm install -g @openai/codex' } : x))
    delete c.codex
    await route.fulfill({ response: res, json: c })
  })
  await page.addInitScript(() => localStorage.setItem('dakort.provider', 'claude'))
  await openNew(page)
  const m = menu(page)
  await m.chip.click()
  await m.tab('codex').click()
  await expect(m.shown).toHaveAttribute('data-agent', 'codex')
  const off = m.shown.locator('.picker-off')
  await expect(off).toContainText('Not installed')
  await expect(off.locator('code').first()).toHaveText('npm install -g @openai/codex')
  await expect(m.shown.locator('[role=option]')).toHaveCount(0)
  // The pointer off the switch: the page takes its own height.
  const at = (await m.tab('codex').boundingBox())!
  await page.mouse.move(at.x + at.width / 2, at.y + 200)
  await expect.poll(() => m.panel.evaluate((el) => el.style.height)).toBe('')
  await fitsItsPage(m.panel)
  await page.screenshot({ path: `test-results/model-menu-${info.project.name}-nocodex.png` })
  await page.keyboard.press('Escape')

  installed = true
  await page.reload()
  await page.locator('.composer textarea').waitFor()
  await m.chip.click()
  await m.tab('codex').click()
  await expect(off).toContainText('Codex listed no models')
  await expect(off.locator('code').first()).toHaveText('codex')
  await expect(m.shown.locator('[role=option]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(sends).toEqual([])
})

// Compact when idle left the cache clock's popup for the model menu: the
// switch saves at once (the test server's own settings), a reload keeps
// it, and it is put back after.
test('compact when idle is a switch in the model menu', async ({ page }) => {
  const s = await openSession(page, settled)
  const m = menu(page)
  const sw = m.shown.getByRole('switch', { name: 'Compact when idle' })
  const saved = async () => ((await (await page.request.get('/api/sessions')).json()) as (Session & { idleCompact?: boolean })[]).find((x) => x.id === s.id)?.idleCompact !== false
  const was = await saved()
  await m.chip.click()
  await expect(sw).toHaveAttribute('aria-checked', String(was))
  await sw.click()
  await expect.poll(saved).toBe(!was)
  await expect(sw).toHaveAttribute('aria-checked', String(!was))
  await expect(m.panel).toBeVisible() // a switch keeps the panel open
  await page.reload()
  await page.locator('.transcript [data-anchor]').first().waitFor()
  await m.chip.click()
  await expect(sw).toHaveAttribute('aria-checked', String(!was))
  await sw.click()
  await expect.poll(saved).toBe(was)
  await page.keyboard.press('Escape')
})

// The agent is chosen when a session starts. A session with history
// keeps its own: its menu has no switch and no other agent's models, only
// its own with its settings, each a name and a one-line caption (the full
// explanation in the row's tooltip). Nothing is sent.
test('a session with history offers only its own agent', async ({ page }, info) => {
  const sends = await noSends(page)
  // One last run on a model the menu lists, or on none (Default is ticked):
  // an older id (claude-opus-5) is kept as it is, so no row carries the tick.
  await page.goto('/login?token=' + token)
  const cfg = await (await page.request.get('/api/config')).json()
  const listed = new Set<string>((cfg.claude?.models ?? []).map((m: { full: string }) => m.full))
  const onListed = (x: Session) => !x.used?.model || listed.has(x.used.model.replace(/\[.*$/, ''))
  await openSession(page, (l) => settled(l.filter(onListed)))
  const m = menu(page)
  await expect(m.chip.locator('.agent-icon.claude')).toHaveCount(1)
  await m.chip.click()
  await expect(m.panel).toBeVisible()
  await expect(m.panel.locator('[role=tablist], [role=tab]')).toHaveCount(0)
  await expect(m.panel.locator('.picker-page')).toHaveCount(1)
  await expect(m.shown).toHaveAttribute('data-agent', 'claude')
  await expect(m.shown.locator('[role=option]', { hasText: /GPT/ })).toHaveCount(0)
  await expect(m.shown.locator('[role=option][aria-selected=true]')).toHaveCount(1)
  await expect(m.panel).not.toContainText('Opens a new')
  // The settings: Effort with its menu of steps, Chrome and Compact when
  // idle, each a name and a one-line caption (no info buttons, no long
  // tips), every caption on one line at this width.
  const effort = m.shown.locator('.picker-row.static').first()
  await expect(effort.locator('.row-label')).toHaveText('Effort')
  await m.shown.locator('.effort-select').click()
  await expect(page.getByRole('menuitemradio')).toHaveText([/^Default/, 'Low', 'Medium', 'High', 'XHigh', 'Max'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(m.panel).toBeVisible() // that Escape closed only the effort menu
  for (const name of ['Chrome', 'Compact when idle']) await expect(m.shown.getByRole('switch', { name, exact: true })).toBeVisible()
  await expect(m.shown.getByRole('button', { name: /^About / })).toHaveCount(0)
  const captions = await m.shown.locator('.row-caption').evaluateAll((els) =>
    els.map((c) => ({ text: c.textContent, cut: c.scrollWidth > c.clientWidth + 1, lines: Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight)) })),
  )
  expect(captions.length).toBe(3)
  for (const c of captions) expect(c, c.text!).toMatchObject({ cut: false, lines: 1 })
  // The switch rows are one height, the switches in one column.
  const rows = await m.shown.locator('.picker-switch').evaluateAll((els) => els.map((r) => r.getBoundingClientRect().height))
  expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(3)
  const knobs = await m.shown.locator('.picker-switch .switch').evaluateAll((els) => els.map((k) => Math.round(k.getBoundingClientRect().right)))
  expect(new Set(knobs).size).toBe(1)
  await page.screenshot({ path: `test-results/model-menu-${info.project.name}-history.png` })
  await page.keyboard.press('Escape')
  expect(sends).toEqual([])
})

// The model menu lies inside the screen: just above its own chip on a laptop,
// on a phone a bottom sheet as wide as the screen over a dimmed page;
// every row is reachable by scrolling it; on a phone every row, step, tab
// and switch is at least 44 px tall, and the models' rows are a name and
// a caption, not paragraphs of prices.
test('the model menu fits the screen, with touch-sized rows on a phone', async ({ page }, info) => {
  const sends = await noSends(page)
  await page.addInitScript(() => localStorage.setItem('dakort.provider', 'claude'))
  await openNew(page)
  const m = menu(page)
  await m.chip.click()
  await expect(m.shown).toHaveAttribute('data-agent', 'claude')
  await risen(m.panel)
  const vp = page.viewportSize()!
  const box = (await m.panel.boundingBox())!
  const composer = (await page.locator('.composer-box').boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  if (info.project.name === 'desktop') {
    // By its own chip, not over the composer's top: 4 to 6 px above it,
    // the two left edges in line, inside the box's width.
    const chip = (await m.chip.boundingBox())!
    expect(chip.y - (box.y + box.height)).toBeGreaterThanOrEqual(3.5)
    expect(chip.y - (box.y + box.height)).toBeLessThanOrEqual(6.5)
    expect(Math.abs(box.x - chip.x)).toBeLessThan(1)
    expect(box.x).toBeGreaterThanOrEqual(composer.x)
  }
  else {
    expect(box).toMatchObject({ x: 0, width: vp.width })
    expect(Math.abs(box.y + box.height - vp.height)).toBeLessThan(1)
    await expect(page.locator('.menu-scrim')).toBeVisible()
    // Its header names it and has a close button.
    await expect(m.panel.locator('.menu-grab .bar b')).toHaveText('Model and settings')
    await expect(m.panel.getByRole('button', { name: 'Close' })).toBeVisible()
  }
  // Scrolled to its end, the last row is inside the panel.
  await m.panel.evaluate((el) => (el.scrollTop = el.scrollHeight))
  const last = (await m.shown.locator('.picker-row').last().boundingBox())!
  expect(last.y + last.height).toBeLessThanOrEqual(box.y + box.height)
  await m.panel.evaluate((el) => (el.scrollTop = 0))
  // A model row: one line of caption, whatever the width.
  const caps = await m.shown.locator('.opt-desc').evaluateAll((els) => els.map((c) => Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight))))
  for (const n of caps) expect(n).toBe(1)
  if (info.project.name === 'desktop') return expect(sends).toEqual([])
  const small = await m.panel.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('.picker-page.on .picker-row, .picker-page.on [data-item], [role=tab]')]
      .map((e) => ({ what: e.getAttribute('aria-label') || e.textContent?.slice(0, 30), w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height }))
      .filter((r) => r.w < 44 || r.h < 44),
  )
  expect(small).toEqual([])
  // The step in use (Effort's, the agent switch's) fills only the shape
  // inside its 44 px target: the control's outline is drawn 4 px in, and
  // the wash once overflowed it by those 4 px above and below.
  const fills = await m.panel.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('.effort button.on, .picker-tab.on')].map((b) => {
      const s = getComputedStyle(b)
      const track = b.parentElement!
      const o = getComputedStyle(track, '::before')
      return { clip: s.backgroundClip, fill: b.getBoundingClientRect().height - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth), outline: track.getBoundingClientRect().height - parseFloat(o.top) - parseFloat(o.bottom) }
    }),
  )
  expect(fills.length).toBeGreaterThan(0)
  for (const f of fills) {
    expect(f.clip).toBe('padding-box')
    expect(Math.abs(f.fill - f.outline)).toBeLessThanOrEqual(1)
  }
  // The header's close: 44 px, and it closes the sheet.
  const close = m.panel.getByRole('button', { name: 'Close' })
  const cb = (await close.boundingBox())!
  expect(Math.min(cb.width, cb.height)).toBeGreaterThanOrEqual(44)
  await close.click()
  await expect(m.panel).toHaveCount(0)
  expect(sends).toEqual([])
})

// In a new session nothing needs carrying: a Codex model makes it a Codex
// session, in place, and the panel stays open on that page, now the
// session's own, for the effort. And back to Claude the same way.
test('a Codex model in an empty session switches it to Codex', async ({ page }) => {
  const sends = await noSends(page)
  await page.addInitScript(() => localStorage.setItem('dakort.provider', 'claude'))
  const s = await openSession(page, settled)
  const cfg = await config(page)
  test.skip(!cfg.codex?.models.length, 'Codex lists no models here')
  const target = cfg.codex!.models[0]
  await seedTabs(page, s.folder!, { ids: ['new'], active: 'new' })
  await page.reload()
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', 'new')
  await expect(page.locator('.tab.active .agent-icon.claude')).toHaveCount(1)
  const m = menu(page)
  await m.chip.click()
  await expect(m.shown).toHaveAttribute('data-agent', 'claude')
  // A new session has no idle compaction to set yet.
  await expect(m.shown.getByRole('switch', { name: 'Compact when idle' })).toHaveCount(0)
  await m.tab('codex').click()
  // Turned, not switched; no note: nothing to carry.
  await expect(page.locator('.tab.active .agent-icon.claude')).toHaveCount(1)
  await expect(m.shown.locator('.picker-page-note')).toHaveCount(0)
  await m.shown.locator('[role=option]', { hasText: target.label }).first().click()
  // Switched in place; the panel stays on Codex's page, now the session's.
  await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', 'new')
  await expect(page.locator('.tab.active .agent-icon.codex')).toHaveCount(1)
  await expect(m.chip.locator('.agent-icon.codex')).toHaveCount(1)
  await expect(m.chip).toContainText(target.label)
  await expect(m.shown).toHaveAttribute('data-agent', 'codex')
  await expect(m.shown.locator('[role=option][aria-selected=true]')).toContainText(target.label)
  await expect(m.shown.locator('.effort-select')).toHaveCount(1)
  await expect(m.shown.getByRole('switch')).toHaveCount(0) // Chrome is Claude's
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Start a new session in this project')
  await page.keyboard.press('Escape')
  await m.chip.click()
  await expect(m.shown).toHaveAttribute('data-agent', 'codex')
  await m.tab('claude').click()
  await m.shown.locator('[role=option]').nth(1).click()
  await expect(m.chip.locator('.agent-icon.claude')).toHaveCount(1)
  await expect(page.locator('.tab.active .agent-icon.claude')).toHaveCount(1)
  await expect(m.shown.getByRole('switch', { name: 'Chrome' })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(sends).toEqual([])
})

// A session ending on a lapsed login (the row the CLI wrote on 2026-11-17,
// its words carrying no "/login") offers the sign-in under it, after a
// reload too, and once only; the turn's bare reason ("api_error") adds no
// second box. The rows are added to the page's tail here, and Sign in is
// answered here, so no login runs.
test('a lapsed login offers the sign-in, once, after a reload', async ({ page }) => {
  const s = await openSession(page, quiet)
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const words = 'Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again'
  // The tail, with or without n (not a catch-up, which goes by after=).
  const tail = new RegExp(`/api/sessions/${s.id}/rows(\\?(?!.*after=).*)?$`)
  await page.route(tail, async (route) => {
    const res = await route.fetch()
    const page_ = await res.json()
    const end = page_.rows.at(-1)?.end ?? 0
    const at = new Date().toISOString()
    const base = { offset: end, end, time: at }
    page_.rows.push(
      { ...base, uuid: 'madetest-p', role: 'user', blocks: [{ type: 'text', text: 'is this a heart starved of blood' }] },
      { ...base, uuid: 'madetest-e', role: 'assistant', model: '<synthetic>', apiError: true, error: 'authentication_failed', blocks: [{ type: 'text', text: words }] },
    )
    return route.fulfill({ json: page_ })
  })
  await page.reload()
  const t = page.locator('.transcript')
  await expect(t.locator('.notice.error:not(.signin)').last()).toContainText('Failed to authenticate')
  await expect(t.locator('.signin')).toHaveCount(1)
  await expect(t.locator('.signin').getByRole('button', { name: 'Sign in' })).toBeVisible()
  // The turn's end, as the stream says it: no bare "api_error", one sign-in.
  await play({ type: 'turn', session: s.id, state: 'done', result: { ok: false, reason: 'api_error', signIn: true } })
  await play({ type: 'turn', session: s.id, state: 'done', result: { ok: false, reason: 'api_error' } })
  await expect(t.locator('.signin')).toHaveCount(1)
  await expect(t.getByText('api_error', { exact: true })).toHaveCount(0)
  // A sign-in that cannot start (answered here, so nothing runs) says so
  // in the app's words, with the server's reason under it.
  await page.route('**/api/signin**', (r) => r.fulfill({ status: 500, contentType: 'text/plain', body: 'madetest: cannot start' }))
  const card = t.locator('.signin')
  await card.getByRole('button', { name: 'Sign in' }).click()
  await expect(card.getByRole('alert')).toContainText('Could not start the sign-in.')
  await expect(card.getByRole('alert')).toContainText('madetest: cannot start.')
  await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.unroute(tail)
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
  await row.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => stops).toBe(1)
  await play({ type: 'leftovers', session: s.id })
  await expect(row).toHaveCount(0)
  await page.unroute(`**/api/sessions/${s.id}/leftovers/4242/stop`)
})

// The context meter sits in the composer's row of controls, under the
// text, never over it: a laptop shows the tokens, a phone the share of the
// window (the tokens are in its tip). It once hung in the box's top corner
// on a phone, a bar with no number, over the first line of a message.
test('the context meter sits in the row of controls, under the text', async ({ page }, info) => {
  // A session whose last reply says its context size: not every one does
  // (a session that ended on an error, or an old CLI's), so try a few.
  const ctx = page.locator('.composer .meter .ctx')
  let found = false
  for (let i = 0; i < 4 && !found; i++) {
    await openSession(page, (l) => l.filter((x) => x.provider !== 'codex' && !x.heldBy && x.size > 100_000).sort((a, b) => a.size - b.size)[i] ?? l[0])
    found = await ctx.waitFor({ state: 'attached', timeout: 3000 }).then(() => true, () => false)
  }
  test.skip(!found, 'no session here has a context size')
  // A long model name on a phone: the meter steps aside (useTightRow's
  // step 3) so the name is whole; that is the row working.
  if (await page.locator('.composer-row[data-nometer]').count()) {
    await expect(ctx).toBeHidden()
    const cut = await page.locator('.composer .model-menu .chip-btn').evaluate((el) => {
      const r = document.createRange()
      r.selectNodeContents(el)
      const cs = getComputedStyle(el)
      return r.getBoundingClientRect().width > el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 0.5
    })
    expect(cut, 'the model chip is cut although the meter stepped aside').toBe(false)
    return
  }
  await expect(ctx).toBeVisible()
  const num = ctx.locator('.ctx-num')
  if (info.project.name === 'desktop') await expect(num).toBeVisible()
  else if (await ctx.locator('.ctx-pct').count()) await expect(num).toBeHidden()
  const meter = (await page.locator('.composer .meter').boundingBox())!
  const box = (await page.locator('.composer-box textarea').boundingBox())!
  expect(meter.y).toBeGreaterThanOrEqual(box.y + box.height - 1)
  await expect(page.locator('.composer .meter')).toHaveAttribute('data-tip', /^\S+ (of \S+ )?tokens/) // one short line
  await expect(page.locator('.composer .meter')).toHaveAttribute('aria-label', /Context: \S+ (of \S+ )?tokens/)
})

// More than two fold into one line with Show and Stop all, and the opened
// list scrolls rather than covering the transcript (ten watcher processes
// did, on 2026-11-15).
test('many processes left running fold into one line', async ({ page }, info) => {
  const s = await openSession(page, (l) => l.filter((x) => x.provider !== 'codex' && !x.heldBy)[0] ?? l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const stopped: string[] = []
  await page.route(`**/api/sessions/${s.id}/leftovers/*/stop`, (route) => {
    stopped.push(route.request().url().split('/').at(-2)!)
    return route.fulfill({ json: {} })
  })
  const started = new Date(Date.now() - 8 * 3600_000).toISOString()
  const many = Array.from({ length: 10 }, (_, i) => ({ pid: 5000 + i, name: i % 2 ? 'tail.exe' : 'bash.exe', command: `watcher ${i}`, started }))
  await play({ type: 'leftovers', session: s.id, leftovers: many })
  const head = page.locator('.leftovers .leftovers-head')
  const rows = page.locator('.leftovers .leftovers-list .queued-item')
  await expect(head).toContainText('10 processes still running')
  await expect(rows).toHaveCount(0)
  await head.getByRole('button', { name: 'Show' }).click()
  await expect(rows).toHaveCount(10)
  const list = page.locator('.leftovers .leftovers-list')
  const box = (await list.boundingBox())!
  expect(box.height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.3 + 1)
  await page.screenshot({ path: `test-results/leftovers-many-${info.project.name}.png` })
  await head.getByRole('button', { name: 'Hide' }).click()
  await expect(rows).toHaveCount(0)
  await head.getByRole('button', { name: 'Stop all' }).click()
  await expect.poll(() => stopped.length).toBe(10)
  expect(new Set(stopped).size).toBe(10)
  await play({ type: 'leftovers', session: s.id })
  await expect(head).toHaveCount(0)
  await page.unroute(`**/api/sessions/${s.id}/leftovers/*/stop`)
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
  // One button at the row's end (Claude desktop's): Stop while the box is
  // empty, Queue in its place once there is something to send.
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toHaveCount(0)
  await box.fill('madetest first')
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toMatchObject({ text: 'madetest first', queue: true })
  await expect(box).toHaveValue('')
  await play({ type: 'queue', session: s.id, queue: [{ promptId: String(bodies[0].promptId), text: 'madetest first' }, { promptId: 'p2', text: 'madetest second' }] })
  await expect(page.locator('.queued-item')).toHaveCount(2)
  await expect(page.locator('.queued-item').first()).toContainText('madetest first')
  await page.screenshot({ path: `test-results/queue-${info.project.name}.png` })

  // Taken back to the box.
  await page.locator('.queued-item').first().getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(box).toHaveValue('madetest first')
  await play({ type: 'queue', session: s.id, queue: [{ promptId: 'p2', text: 'madetest second' }] })
  await expect(page.locator('.queued-item')).toHaveCount(1)

  // A stop hands the rest back too: with a draft in the box, Escape in it
  // stops (the button there is Queue).
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await box.press('Escape')
  await expect(box).toHaveValue('madetest first\n\nmadetest second')
  await play({ type: 'queue', session: s.id })
  await play({ type: 'turn', session: s.id, state: 'done' })
  await expect(page.locator('.queued-item')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await box.fill('')
  for (const r of ['send', 'unqueue/*', 'interrupt']) await page.unroute(`**/api/sessions/*/${r}`)
})

// A running turn has one running mark, a muted working line at the end of
// the reply, and no ring anywhere in the transcript; the reply's time and
// Copy come once the turn has ended, never between its tools and that line.
test('a running turn shows one quiet working line, and its time only once done', async ({ page }) => {
  const s = await openSession(page, quiet)
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const t = page.locator('.transcript')
  const lastReply = t.locator('.item-wrap').last()
  await play({ type: 'turn', session: s.id, state: 'running' })
  await expect(t.locator('.working')).toHaveCount(1)
  await expect(t.locator('.working .shimmer')).toHaveText(/…$/)
  await expect(t.locator('.ring')).toHaveCount(0)
  const color = await t.locator('.working').evaluate((el) => getComputedStyle(el).color)
  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())
  expect(color).not.toBe(accent)
  if (await lastReply.locator('.reply').count()) await expect(lastReply.locator('.reply-actions')).toHaveCount(0)
  await play({ type: 'turn', session: s.id, state: 'done', result: { ok: true } })
  await expect(t.locator('.working')).toHaveCount(0)
  if (await lastReply.locator('.reply').count()) await expect(lastReply.locator('.reply-actions')).toHaveCount(1)
})

// Background tasks that outlive their turn (agents, commands) show as
// work: the session's tab in its tasks state (the agent's mark breathing,
// no dot), not the turn's, and the page icon's working look, where both
// once read as idle while agents ran. The task's chip opens a card that
// says what it is, by hover or by a tap.
test('background tasks after a turn still show as work', async ({ page }, info) => {
  const s = await openSession(page, (l) => l[0])
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const icon = page.locator('link[rel="icon"]')
  const tab = page.locator(`.tabs .tab[data-tab="${s.id}"]`)
  await expect(tab).not.toHaveAttribute('data-state', 'tasks')
  const started = new Date(Date.now() - 125_000).toISOString()
  await play({ type: 'tasks', session: s.id, tasks: [{ id: 'k1', type: 'local_agent', description: 'Research', started, subagent: 'Explore', model: 'sonnet', steps: 3, last: 'Reading the docs' }] })
  await expect(tab).toHaveAttribute('data-state', 'tasks')
  // The tab in use shows its ×, not the tasks ring (a tab not in use shows
  // the ring in the ×'s slot, the tab check in shell.spec covers that).
  await expect(tab.locator('.dot')).toBeHidden()
  await expect(icon).toHaveAttribute('data-state', 'run')
  const chip = page.locator('.composer .task-label', { hasText: 'Research' })
  if (info.project.name === 'desktop') await chip.hover()
  else await chip.click()
  const card = page.locator('.task-card')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Background agent')
  await expect(card).toContainText('Sonnet')
  await expect(card).toContainText(/running 2m \d+s/)
  await expect(card).toContainText('3 steps')
  await expect(card).toContainText('Reading the docs')
  await page.keyboard.press('Escape')
  await play({ type: 'tasks', session: s.id, tasks: [] })
  await expect(tab).not.toHaveAttribute('data-state', 'tasks')
  await expect(icon).toHaveAttribute('data-state', 'idle')
})

// The composer's controls are one row of whole parts: none overlaps
// another or leaves the box, and on a phone each is a 44 px target (they
// once floated as unrelated pills of 22 to 32 px, a lone clock among them).
test('the composer is one row of whole, separate controls', async ({ page }, info) => {
  await openSession(page, quiet)
  const box = (await page.locator('.composer-box').boundingBox())!
  const vw = page.viewportSize()!.width
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vw)
  const parts = await page.locator('.composer-row').evaluate((row) =>
    [...row.querySelectorAll<HTMLElement>(':scope > button, :scope > .picker > button, :scope > .mode-chip, :scope > .composer-end > :is(button, .held-note)')]
      .filter((e) => e.offsetParent)
      .map((e) => {
        const r = e.getBoundingClientRect()
        return { name: e.getAttribute('aria-label') || e.className, x: r.x, y: r.y, w: r.width, h: r.height, cut: e.scrollWidth > e.clientWidth + 1 }
      }),
  )
  expect(parts.length).toBeGreaterThanOrEqual(4) // attach, model, mode, send at least
  const min = info.project.name === 'desktop' ? 28 : 44
  for (const p of parts) {
    expect(p.h, p.name).toBeGreaterThanOrEqual(min)
    expect(p.w, p.name).toBeGreaterThanOrEqual(min)
    expect(p.x, p.name).toBeGreaterThanOrEqual(box.x)
    expect(p.x + p.w, p.name).toBeLessThanOrEqual(box.x + box.width + 0.5)
    expect(p.cut, p.name + ' cut off').toBe(false)
  }
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j]
      const apart = a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5
      expect(apart, `${a.name} overlaps ${b.name}`).toBe(true)
    }
})

// A control's tip (tips.ts) shows on a long press on a phone and on a
// hover with a mouse, and lies inside the screen even for the control at
// the right edge, the send button.
test('tooltips show on touch and stay inside the screen', async ({ page }, info) => {
  await openSession(page, quiet)
  const vp = page.viewportSize()!
  for (const sel of ['.composer .cbtn.attach', '.composer .send']) {
    const el = page.locator(sel).first()
    await el.scrollIntoViewIfNeeded()
    const r = (await el.boundingBox())!
    if (info.project.name === 'desktop') await el.hover()
    else await el.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })
    const tip = page.locator('.tip[data-open]')
    await expect(tip).toBeVisible()
    const t = (await tip.boundingBox())!
    expect(t.x).toBeGreaterThanOrEqual(0)
    expect(t.y).toBeGreaterThanOrEqual(0)
    expect(t.x + t.width).toBeLessThanOrEqual(vp.width)
    expect(t.y + t.height).toBeLessThanOrEqual(vp.height)
    // Close to its button (shadcn's Tooltip distance), in a word or three.
    const gap = t.y + t.height <= r.y ? r.y - (t.y + t.height) : t.y - (r.y + r.height)
    expect(gap, sel + ' tip distance').toBeGreaterThanOrEqual(4)
    expect(gap, sel + ' tip distance').toBeLessThanOrEqual(8)
    expect(((await tip.textContent()) ?? '').trim().split(/\s+/).length, sel + ' tip words').toBeLessThanOrEqual(3)
    if (info.project.name !== 'desktop') await el.dispatchEvent('pointerup', { pointerType: 'touch' })
    await page.keyboard.press('Escape')
    await page.mouse.move(0, 0)
    await expect(tip).toHaveCount(0)
  }
})

// Tips are for icon-only buttons: a row or a tab that shows its name (a
// project, a session's tab, a file) gets none (review of 2026-11-24).
test('rows and tabs that show their name have no tooltip', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'hover is a mouse thing')
  await openSession(page, quiet)
  const tip = page.locator('.tip[data-open]')
  for (const sel of ['.tab.active', '.folder-list .folder-row', '.explorer-panel .tree-row']) {
    await page.locator(sel).first().hover()
    await page.waitForTimeout(900)
    await expect(tip, sel).toHaveCount(0)
  }
  // An icon button beside them still has its short tip.
  await page.getByRole('button', { name: 'New session' }).first().hover()
  await expect(tip).toHaveText('New session')
})

// Scrolling up through a long session: nothing but the scroll moves what
// is on screen. A synthetic history of 600 rows (prompts, replies of
// several lengths, tool calls whose results land rows later, so an item
// can span the window's edge) is served with older pages 300 ms late, and
// the view is scrolled up in steps and then in a fling while those pages
// arrive. A row on screen is followed throughout: its position may change
// only by what each scroll moved, never between scrolls (older rows
// landing, an item growing above it, the bottom-follow firing).
test('scrolling up through a long session never jumps', async ({ page }) => {
  test.setTimeout(120_000)
  const s = await openSession(page, quiet)
  const N = 600
  const at = (i: number) => new Date(Date.now() - (N - i) * 60_000).toISOString()
  const rows: object[] = []
  for (let i = 0; rows.length < N; i++) {
    const base = () => ({ offset: rows.length * 100, end: rows.length * 100 + 100, time: at(rows.length) })
    rows.push({ ...base(), uuid: `madetest-p${i}`, role: 'user', blocks: [{ type: 'text', text: `madetest question ${i}` + ' and more'.repeat(i % 7) }] })
    if (i % 3 === 0) {
      rows.push({ ...base(), uuid: `madetest-u${i}`, role: 'assistant', blocks: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: `madetest-t${i}`, name: 'Bash', input: { command: 'ls' } }] })
      rows.push({ ...base(), uuid: `madetest-r${i}`, role: 'user', blocks: [{ type: 'tool_result', id: `madetest-t${i}`, text: 'a\nb' }] })
    }
    rows.push({ ...base(), uuid: `madetest-a${i}`, role: 'assistant', blocks: [{ type: 'text', text: Array.from({ length: 1 + (i % 5) }, (_, k) => `Paragraph ${k} of answer ${i}. ` + 'Words to wrap. '.repeat(8 + ((i * 7 + k) % 20))).join('\n\n') }] })
  }
  const end = rows.length * 100
  await page.route(new RegExp(`/api/sessions/${s.id}/rows`), async (route) => {
    const u = new URL(route.request().url())
    if (u.searchParams.has('after')) return route.fulfill({ json: { rows: [], next: end } })
    const before = Number(u.searchParams.get('before') ?? end)
    const older = rows.filter((r) => (r as { offset: number }).offset < before)
    const got = older.slice(-Number(u.searchParams.get('n') ?? 50))
    if (u.searchParams.has('before')) await new Promise((r) => setTimeout(r, 300))
    return route.fulfill({ json: { rows: got, atStart: got.length === older.length, next: end } })
  })
  await page.reload()
  await page.locator('.transcript [data-anchor]').last().waitFor()
  await page.waitForTimeout(500)

  // In the page: follow the row nearest the middle of the view by its
  // anchor (re-found each time, as an item may be remounted) and its
  // bottom edge (an item can grow at its top). drift adds up every move
  // that no scroll made.
  await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.transcript')!
    const w = window as any
    const pick = () => {
      const r = box.getBoundingClientRect()
      const el = [...box.querySelectorAll<HTMLElement>('[data-anchor]')].find((e) => e.getBoundingClientRect().bottom > r.top + r.height / 2)
      return el?.dataset.anchor ?? ''
    }
    const bottom = (key: string) => box.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(key)}"]`)?.getBoundingClientRect().bottom
    w.jump = { key: pick(), last: 0, drift: [] as string[], moved: 0 }
    w.jump.last = bottom(w.jump.key)
    // check: what moved since the last look, with no scroll in between.
    w.jumpCheck = (why: string) => {
      const j = w.jump
      const b = bottom(j.key)
      if (b === undefined) {
        j.key = pick()
        j.last = bottom(j.key)
        return
      }
      if (Math.abs(b - j.last) > 1) j.drift.push(`${why}: ${j.key} moved ${Math.round(b - j.last)} px with no scroll`)
      j.last = b
      // Far off screen: follow a row in view again.
      const r = box.getBoundingClientRect()
      if (b < r.top - r.height || b > r.bottom + r.height) {
        j.key = pick()
        j.last = bottom(j.key)
      }
    }
    // scroll: one step up, checked before (nothing moved since) and that
    // the row moved by exactly what scrollTop did.
    w.jumpScroll = (dy: number) => {
      const j = w.jump
      w.jumpCheck('between scrolls')
      const top = box.scrollTop
      box.scrollBy(0, -dy)
      const moved = top - box.scrollTop
      const b = bottom(j.key)!
      if (Math.abs(b - j.last - moved) > 1) j.drift.push(`scroll ${dy}: ${j.key} moved ${Math.round(b - j.last)} px, the scroll ${moved}`)
      j.last = b
      j.moved += moved
    }
  })
  const box = page.locator('.transcript')
  // Steps of most of a screen, some 220 ms apart (an older page asked for
  // at 150 ms of rest is still on its way when the next step comes), some
  // with time for the page to land in between.
  for (let i = 0; i < 16; i++) {
    await page.evaluate(() => (window as any).jumpScroll(450))
    await page.waitForTimeout(220)
    await page.evaluate(() => (window as any).jumpCheck('after a step'))
    if (i % 2) {
      await page.waitForTimeout(400)
      await page.evaluate(() => (window as any).jumpCheck('after older rows'))
    }
  }
  // Flings: a step every frame, slowing down, with short rests between,
  // so pages land mid-fling and right at the top of what is loaded.
  for (let f = 0; f < 4; f++) {
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          let n = 0
          const frame = () => {
            ;(window as any).jumpScroll(Math.max(10, 160 - n * 4))
            if (++n < 40) requestAnimationFrame(frame)
            else done()
          }
          requestAnimationFrame(frame)
        }),
    )
    await page.waitForTimeout(200)
    await page.evaluate(() => (window as any).jumpCheck('between flings'))
  }
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250)
    await page.evaluate(() => (window as any).jumpCheck('after the fling'))
  }
  const j = await page.evaluate(() => (window as any).jump)
  expect(j.moved, 'the checks scrolled').toBeGreaterThan(3000)
  expect(await box.evaluate((el) => el.querySelectorAll('[data-anchor^="madetest-"]').length), 'older rows loaded').toBeGreaterThan(60)
  expect(j.drift).toEqual([])
})

// A turn cut off by Interrupted says when, muted beside the word (it has
// no Copy line to carry a time), and a background task's news, a message
// that starts a turn, is a bubble on the right like a prompt, marked as
// the system's. The rows are added to the page's tail; nothing is sent.
test('an interrupt has its time and task news is a message', async ({ page }) => {
  const s = await openSession(page, quiet)
  const tail = new RegExp(`/api/sessions/${s.id}/rows(\\?(?!.*after=).*)?$`)
  await page.route(tail, async (route) => {
    const res = await route.fetch()
    const page_ = await res.json()
    const end = page_.rows.at(-1)?.end ?? 0
    const base = { offset: end, end, time: new Date().toISOString() }
    const text = (t: string) => ({ type: 'text', text: t })
    page_.rows.push(
      { ...base, uuid: 'madetest-p', role: 'user', blocks: [text('madetest prompt')] },
      { ...base, uuid: 'madetest-a', role: 'assistant', blocks: [{ type: 'tool_use', id: 'madetest-1', name: 'Bash', input: { command: 'sleep 60' } }] },
      { ...base, uuid: 'madetest-r', role: 'user', blocks: [{ type: 'tool_result', id: 'madetest-1', text: '', isError: true }] },
      { ...base, uuid: 'madetest-i', role: 'user', blocks: [text('[Request interrupted by user]')] },
      { ...base, uuid: 'madetest-n', role: 'user', blocks: [text('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "madetest restart" completed (exit code 0)</summary>\n</task-notification>')] },
      { ...base, uuid: 'madetest-b', role: 'assistant', blocks: [text('madetest answer')] },
    )
    return route.fulfill({ json: page_ })
  })
  await page.reload()
  const t = page.locator('.transcript')
  const stop = t.locator('.notice.info', { hasText: 'Interrupted' }).last()
  await expect(stop.locator('.reply-time')).toHaveText(/\d:\d\d/)
  await expect(stop.locator('.copy-btn')).toHaveCount(0)
  const msg = t.locator('.task-msg').last()
  await expect(msg).toContainText('Background task finished')
  await expect(msg).toContainText('madetest restart')
  await expect(msg).toContainText('exit code 0')
  await expect(msg).not.toContainText('Background command')
  // On the right, as a prompt is.
  const col = (await t.locator('.reply').last().boundingBox())!
  const box = (await msg.boundingBox())!
  expect(Math.abs(box.x + box.width - (col.x + col.width))).toBeLessThanOrEqual(2)
  expect(box.width).toBeLessThan(col.width * 0.9)
})

// The conversation's parts at full size on a phone: a run of tool calls is
// one 44 px line that opens to 44 px rows, an edit opens to a diff with
// its signs, a code block's Copy sits in a header strip above the code,
// and an approval's Deny and Allow are 44 px tall inside the column, the
// waiting line saying it needs you. The rows are added to the page's tail
// and the turn and approval played in; nothing is sent or answered.
test('tool runs, diffs, code blocks and approvals are full size', async ({ page }, info) => {
  const s = await openSession(page, quiet)
  const play = (ev: object) => page.evaluate((ev) => (window as any).dakort.stream.onEvent(ev), ev)
  const tail = new RegExp(`/api/sessions/${s.id}/rows(\\?(?!.*after=).*)?$`)
  await page.route(tail, async (route) => {
    const res = await route.fetch()
    const page_ = await res.json()
    const end = page_.rows.at(-1)?.end ?? 0
    const base = { offset: end, end, time: new Date().toISOString() }
    const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input })
    const result = (id: string, text: string, isError = false) => ({ type: 'tool_result', id, text, isError })
    page_.rows.push(
      { ...base, uuid: 'madetest-p', role: 'user', blocks: [{ type: 'text', text: 'madetest prompt' }] },
      {
        ...base,
        uuid: 'madetest-a',
        role: 'assistant',
        blocks: [
          use('madetest-1', 'Read', { file_path: '/madetest/src/a.ts' }),
          use('madetest-2', 'Edit', { file_path: '/madetest/src/a.ts', old_string: 'one\ntwo', new_string: 'one\nTWO\nthree' }),
          use('madetest-3', 'Bash', { command: 'npm run lint', description: 'Lint' }),
          use('madetest-4', 'Bash', { command: 'cd /madetest && go test ./...' }),
        ],
      },
      { ...base, uuid: 'madetest-r', role: 'user', blocks: [result('madetest-1', '1\tone\n2\ttwo'), result('madetest-2', 'ok'), result('madetest-3', 'error: x', true), result('madetest-4', 'ok')] },
      { ...base, uuid: 'madetest-t', role: 'assistant', blocks: [{ type: 'text', text: 'Done.\n\n```ts\nconst a: number = 1 // ' + 'long '.repeat(40) + '\n```' }] },
    )
    return route.fulfill({ json: page_ })
  })
  await page.reload()
  const t = page.locator('.transcript')
  const run = t.locator('.run-line').last()
  // The group's line is the plain summary: no counts, no "1 failed" (its
  // red dot says so).
  await expect(run).toHaveText(/^\s*Read 1 file · edited 1 file · ran 2 commands\s*$/)
  await expect(run.locator('.dot.failed')).toHaveCount(1)
  const phone = info.project.name !== 'desktop'
  const tall = async (l: Locator) => (await l.boundingBox())!.height
  if (phone) expect(await tall(run)).toBeGreaterThanOrEqual(44)
  await run.click()
  // Closed, a command's row is words only: its description, else words
  // made from the command; the command shows once the row is open.
  const lint = t.locator('.tool-line', { hasText: 'Lint' }).last()
  await expect(lint).not.toContainText('npm run lint')
  await expect(lint).toContainText('Failed')
  const tests = t.locator('.tool-line', { hasText: 'Run Go tests' }).last()
  await expect(tests).not.toContainText('go test')
  await tests.click()
  await expect(t.locator('.tool-body').last()).toContainText('go test ./...')
  await tests.click()
  const edit = t.locator('.tool-line', { hasText: 'a.ts' }).nth(1)
  if (phone) expect(await tall(edit)).toBeGreaterThanOrEqual(44)
  await edit.click()
  const diff = t.locator('.diff-card')
  await expect(diff.locator('.diff-line.add')).toHaveCount(2)
  await expect(diff.locator('.diff-line.del .diff-sign')).toHaveText('−')
  // Copy is in the header, above the code, not over its first line (its
  // touch target may reach into the pre's padding, not into the text).
  const block = t.locator('.code-block').last()
  const copy = (await block.locator('.code-copy').boundingBox())!
  const code = (await block.locator('pre code').boundingBox())!
  expect(copy.y + copy.height).toBeLessThanOrEqual(code.y + 1)
  if (phone) expect(copy.height).toBeGreaterThanOrEqual(44)
  await expect(block.locator('.code-lang')).toHaveText('ts')
  // An approval: the line says it waits, the card sits in the column.
  await play({ type: 'turn', session: s.id, state: 'running' })
  await play({ type: 'permission', session: s.id, permission: { id: 'madetest-perm', tool: 'Bash', input: { command: 'madetest' } } })
  await expect(t.locator('.working.needs-you')).toContainText('Waiting for you')
  const card = page.locator('.perm-card')
  await expect(card.locator('.term-cmd')).toContainText('madetest')
  for (const name of ['Deny…', 'Allow']) {
    const b = (await card.getByRole('button', { name }).boundingBox())!
    expect(b.height).toBeGreaterThanOrEqual(phone ? 44 : 32)
  }
  const col = (await card.boundingBox())!
  expect(col.width).toBeLessThanOrEqual(800 + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await play({ type: 'permissionDone', session: s.id, requestId: 'madetest-perm' })
  await play({ type: 'turn', session: s.id, state: 'done' })
  await page.unroute(tail)
})
