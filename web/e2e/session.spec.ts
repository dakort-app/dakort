import { expect, test } from '@playwright/test'
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
  await page.locator('.composer .chip-btn').click()
  await page.locator('.picker-panel .picker-row', { hasText: 'Fable' }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.composer .chip-btn')).toContainText('Fable')
  await page.locator('.composer textarea').fill('hello')
  await page.locator('.composer textarea').press('Enter')
  await page.waitForTimeout(1000)
  await expect(page.locator('.composer .chip-btn')).toContainText('Fable')
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

// A session ending on a lapsed login (the row the CLI wrote on 2026-11-17,
// its words carrying no "/login") offers the sign-in under it, after a
// reload too, and once only; the turn's bare reason ("api_error") adds no
// second box. The rows are added to the page's tail here, and Sign in is
// not pressed, so no login runs.
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
  await row.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => stops).toBe(1)
  await play({ type: 'leftovers', session: s.id })
  await expect(row).toHaveCount(0)
  await page.unroute(`**/api/sessions/${s.id}/leftovers/4242/stop`)
})

// On a phone the context meter sits in the box's corner; the number is
// hidden there (bar only), so the first line of a message does not run
// under it. On a desktop the row has room for both.
test('the context meter leaves room for the first line on a phone', async ({ page }, info) => {
  await openSession(page, (l) => l.filter((x) => x.provider !== 'codex' && !x.heldBy && x.size > 100_000).sort((a, b) => a.size - b.size)[0])
  const ctx = page.locator('.composer .ctx')
  await expect(ctx).toBeVisible()
  const num = ctx.locator('.ctx-num')
  if (info.project.name === 'desktop') {
    await expect(num).toBeVisible()
  } else {
    await expect(num).toBeHidden()
    const meter = (await ctx.boundingBox())!
    const box = (await page.locator('.composer-box textarea').boundingBox())!
    const pad = await page.locator('.composer-box textarea').evaluate((el) => parseFloat(getComputedStyle(el).paddingRight))
    expect(meter.width).toBeLessThanOrEqual(pad)
    expect(meter.x).toBeGreaterThanOrEqual(box.x + box.width - pad - 1)
  }
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
