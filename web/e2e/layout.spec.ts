// Alignment, measured: each key screen at two laptop sizes, light and
// dark, through alignAudit (align.mjs), which lists siblings, controls,
// icons and list rows that sit 1 to 3 px off each other. A check fails on
// any finding and prints each as "kind delta: elements {numbers}"; the
// screen is saved under test-results/align-<screen>-<size>-<theme>.png.
// Larger offsets are taken as meant and only counted. An offset that is
// meant (an optically centred icon) is marked data-align-ok="<why>" in
// the markup; a region to skip, data-align-ignore.

import { expect, test, type Page } from '@playwright/test'
import { closeOpened, openSession, quiet, seedTabs, token, type Session } from './helpers'

test.skip(!token, 'DAKORT_TOKEN not set')
test.afterEach(closeOpened)

const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]
const THEMES = ['light', 'dark'] as const

type Finding = { kind: string; delta: number; a: string; b?: string; values?: unknown }
type Report = { total: number; findings: Finding[] }

// align.mjs is plain JS for the screenshot tools too; loaded by URL so
// the type check does not ask for its types.
const alignUrl = new URL('./align.mjs', import.meta.url).href
let alignAudit: ((opts: object) => Report) | undefined

// prepare sizes the page and picks the theme the app's way (theme.ts reads
// dakort.theme before the first paint), with the sidebar shown or hidden,
// and stops motion so nothing is measured mid-move.
async function prepare(page: Page, size: { width: number; height: number }, theme: string, sidebar: boolean) {
  await page.setViewportSize(size)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(
    ([theme, sidebar]) => {
      localStorage.setItem('dakort.theme', theme)
      localStorage.setItem('dakort.explorerShown', sidebar ? '1' : '0')
      const still = () => {
        const s = document.createElement('style')
        s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
        document.head.appendChild(s)
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', still)
      else still()
    },
    [theme, sidebar] as const,
  )
}

async function audit(page: Page, name: string) {
  alignAudit ??= (await import(alignUrl)).alignAudit as (opts: object) => Report
  await page.evaluate(() => document.fonts.ready.then(() => true))
  await page.waitForTimeout(300)
  const r = await page.evaluate(alignAudit, {})
  await page.screenshot({ path: `test-results/align-${name}.png` })
  const line = (f: Finding) => `${f.kind} ${f.delta}px: ${f.a}${f.b ? '  |  ' + f.b : ''} ${JSON.stringify(f.values)}`
  expect(r.findings.map(line), `${r.total} alignment findings on ${name}`).toEqual([])
}

// A file of the session's folder, from the explorer (a code or text file
// if there is one), for the screens that open a file.
async function someFile(page: Page) {
  await page.locator('.tree-row').first().waitFor()
  const paths = await page.locator('.tree-row:not([aria-expanded])').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-path') ?? ''))
  return paths.find((p) => /\.(tsx?|jsx?|go|py|json|css|md|txt)$/.test(p)) ?? paths[0]
}

// A session with tool rows: the quiet one if it has them, else the first
// that does among the ten newest.
async function withTools(page: Page): Promise<Session | undefined> {
  const s = await openSession(page, quiet)
  if (await page.locator('.transcript .tool-line, .transcript .run-line').count()) return s
  const all: Session[] = await (await page.request.get('/api/sessions')).json()
  for (const x of all.filter((x) => x.folder === s.folder && x.id !== s.id).slice(0, 10)) {
    await seedTabs(page, x.folder!, { ids: [x.id], active: x.id })
    await page.reload()
    await page.locator('.transcript [data-anchor]').first().waitFor()
    if (await page.locator('.transcript .tool-line, .transcript .run-line').count()) return x
  }
  return undefined
}

for (const size of SIZES)
  for (const theme of THEMES) {
    const at = `${size.width}x${size.height}, ${theme}`
    const tag = `${size.width}-${theme}`

    test.describe(at, () => {
      test.skip(({ isMobile }) => isMobile, 'laptop sizes; the phone has its own layout')

      // The home with no project open: title, Open project, the recent list.
      test(`the home lines up at ${at}`, async ({ page }) => {
        await prepare(page, size, theme, true)
        await page.route('**/api/folders', async (r) => {
          if (r.request().method() !== 'GET') return r.fallback()
          const l = await (await r.fetch()).json()
          await r.fulfill({ json: l.map((f: object) => ({ ...f, open: false })) })
        })
        await page.goto('/login?token=' + token)
        await page.goto('/#/')
        await page.getByRole('button', { name: 'Open project' }).first().waitFor()
        await audit(page, `home-${tag}`)
      })

      // A project open with its sidebar: the projects list, the files tree
      // and its header, the tab row.
      test(`an open project with the sidebar lines up at ${at}`, async ({ page }) => {
        await prepare(page, size, theme, true)
        await openSession(page, quiet)
        await page.locator('.explorer-panel .tree-row').first().waitFor()
        await audit(page, `project-${tag}`)
      })

      // The transcript at its tool rows: the folded run, then one opened,
      // their marks, verbs and targets in line.
      test(`a transcript's tool rows line up at ${at}`, async ({ page }) => {
        await prepare(page, size, theme, false)
        const s = await withTools(page)
        test.skip(!s, 'no session with tool rows')
        const run = page.locator('.transcript .run-line[aria-expanded=false]').first()
        if (await run.count()) await run.click()
        // The first one shown: the runs left closed keep theirs in the page.
        const row = page.locator('.transcript .tool-line:visible').first()
        // The transcript may redraw its rows while it settles, replacing the
        // one found; find it again until it holds still.
        await expect(async () => {
          await row.scrollIntoViewIfNeeded({ timeout: 1000 })
        }).toPass({ timeout: 10_000 })
        await audit(page, `tools-${tag}`)
      })

      // The composer with a draft in it: the box, its chips, the meter and
      // the send button on one line.
      test(`the composer lines up at ${at}`, async ({ page }) => {
        await prepare(page, size, theme, false)
        await openSession(page, quiet)
        const box = page.locator('.composer textarea')
        await box.click()
        await box.fill('A draft to measure the composer by')
        await audit(page, `composer-${tag}`)
      })

      // The model menu open: its options with their descriptions and
      // checks, the effort row, the switches.
      test(`the model menu lines up at ${at}`, async ({ page }) => {
        await prepare(page, size, theme, false)
        await openSession(page, quiet)
        await page.getByRole('button', { name: /^Model and settings/ }).click()
        await page.locator('.picker-panel').waitFor()
        await audit(page, `model-menu-${tag}`)
      })

      // A file open beside the session's tab: the file's head (path, its
      // buttons) and the editor's frame.
      test(`an open file lines up at ${at}`, async ({ page }) => {
        await prepare(page, size, theme, true)
        const s = await openSession(page, quiet)
        const file = await someFile(page)
        test.skip(!file, 'no file in the folder')
        await seedTabs(page, s.folder!, { ids: [s.id, 'f:' + file], active: 'f:' + file })
        await page.reload()
        await page.locator('.file-view, .file-md, .cm-editor').first().waitFor()
        await audit(page, `file-${tag}`)
      })

      // Split view: a session and a file side by side, each pane with its
      // own tab row.
      test(`split view lines up at ${at}`, async ({ page }) => {
        await prepare(page, size, theme, true)
        const s = await openSession(page, quiet)
        const file = await someFile(page)
        test.skip(!file, 'no file in the folder')
        await seedTabs(page, s.folder!, { ids: [s.id], active: s.id, right: { ids: ['f:' + file], active: 'f:' + file } })
        await page.reload()
        await expect(page.locator('.editor-panel')).toHaveCount(2)
        await page.locator('.transcript [data-anchor]').first().waitFor()
        await audit(page, `split-${tag}`)
      })
    })
  }

// One icon set at one stroke (icons.tsx): every line icon on the screens
// with the most of them (an open project with its sidebar and tabs, a
// transcript with tool rows, the composer, the model menu open) is an
// Lucide icon (.i from icons.tsx, .lucide inside shadcn's components)
// whose stroke, and its paths', is ICON_STROKE. File-type icons,
// the agents' marks, Dakort's own mark and the context meter's ring draw
// their own.
test('every icon has the same stroke width', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the laptop layout has the most icons on one screen')
  await prepare(page, { width: 1280, height: 800 }, 'light', true)
  await openSession(page, quiet)
  await page.locator('.explorer-panel .tree-row').first().waitFor()
  await page.getByRole('button', { name: /^Model and settings/ }).click()
  await page.locator('.picker-panel').waitFor()
  const bad = await page.evaluate(() => {
    const own = '.file-icon, .agent-icon, .brand-mark, .new-session-mark, .ctx-pie'
    const out: string[] = []
    let n = 0
    for (const svg of document.querySelectorAll('svg')) {
      const b = svg.getBoundingClientRect()
      if (!b.width || svg.closest(own)) continue
      n++
      const id = (svg.getAttribute('class') ?? '') + ' in ' + (svg.parentElement?.getAttribute('aria-label') ?? svg.parentElement?.className ?? '')
      if (!svg.classList.contains('i') && !svg.classList.contains('lucide')) out.push('not from the set: ' + id)
      for (const el of [svg, ...svg.querySelectorAll('path, circle, rect, line, polyline')]) {
        const w = getComputedStyle(el).strokeWidth
        if (w !== '1.75px') out.push(`stroke ${w}: ${id}`)
      }
    }
    return n ? out : ['no icons found']
  })
  expect([...new Set(bad)]).toEqual([])
})
