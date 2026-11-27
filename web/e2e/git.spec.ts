import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeOpened, opened, openSession, token } from './helpers'

test.skip(!token, 'DAKORT_TOKEN not set')
test.afterEach(closeOpened)

// What git says about the project: the explorer marks a changed file and
// the folder holding one, Changes lists them with the branch, and a tap
// opens the file on its diff, with Diff turning it off and on. git's
// answers, the listing's extra files and their contents are served by the
// test (git_test.go runs the real git).
test('changed files show with their diffs', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the sidebar is a drawer on a phone; same code')
  const changed = 'madetest-changed.txt'
  const gone = 'madetest-dir/madetest-gone.txt'
  const inside = 'madetest-new/madetest-inside.txt'
  // Later a second repository, below, has a change too.
  let two = false
  await page.route(/\/api\/git\?/, (route) =>
    route.fulfill({
      json: {
        repo: true,
        branch: 'madetest-branch',
        ahead: 2,
        repos: [{ path: '', branch: 'madetest-branch', ahead: 2, upstream: 'origin/madetest-branch', remote: true, local: [{ path: changed, st: 'M', repo: '', wa: 1, wd: 1 }, { path: gone, st: 'D', repo: '' }] }, ...(two ? [{ path: 'madetest-sub/madetest-paper', branch: 'madetest-other' }] : [])],
        files: [
          { path: changed, st: 'M', repo: '', y: 'M' },
          { path: gone, st: 'D', repo: '', y: 'D' },
          { path: 'madetest-new/', st: 'U', repo: '', y: 'U' },
          ...(two ? [{ path: 'madetest-sub/madetest-paper/madetest-paper.tex', st: 'M', repo: 'madetest-sub/madetest-paper' }] : []),
        ],
      },
    }),
  )
  const diffs: Record<string, string> = {
    [changed]: 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@ top\n one\n-old line\n+new line\n three\n',
    [gone]: 'diff --git a/y b/y\ndeleted file mode 100644\n--- a/y\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n',
    [inside]: 'diff --git a/z b/z\nnew file mode 100644\n--- /dev/null\n+++ b/z\n@@ -0,0 +1 @@\n+all new\n',
  }
  await page.route(/\/api\/git\/log\?/, (route) => route.fulfill({ json: { commits: [] } }))
  await page.route(/\/api\/git\/diff\?/, (route) => {
    const p = new URL(route.request().url()).searchParams.get('path') ?? ''
    return route.fulfill({ json: { diff: diffs[p] ?? '' } })
  })
  await page.route(/\/api\/files\/(list|stat|raw)\?/, async (route) => {
    const u = new URL(route.request().url())
    const p = u.searchParams.get('path') ?? ''
    if (u.pathname.endsWith('/list')) {
      if (p === 'madetest-new') return route.fulfill({ json: [{ name: 'madetest-inside.txt', size: 8, mtime: new Date().toISOString() }] })
      if (p !== '') return route.fallback()
      const list = await (await route.fetch()).json()
      return route.fulfill({ json: [{ name: 'madetest-dir', dir: true, size: 0, mtime: new Date().toISOString() }, ...list, { name: changed, size: 20, mtime: new Date().toISOString() }] })
    }
    if (p === gone) return route.fulfill({ status: 404, json: { error: 'not found' } })
    if (p !== changed) return route.fallback()
    if (u.pathname.endsWith('/stat')) return route.fulfill({ json: { size: 20, mtime: '2026-11-21T00:00:00Z' } })
    return route.fulfill({ body: 'one\nnew line\nthree\n', contentType: 'application/octet-stream' })
  })
  await openSession(page, (l) => l[0])
  const panel = page.locator('.explorer-panel')

  // The explorer: the file in its colour with M, the folder with a dot.
  const row = panel.locator('.tree-row', { hasText: changed })
  await expect(row.locator('.git-mark')).toHaveText('M')
  await expect(panel.locator('.tree-row', { hasText: 'madetest-dir' }).locator('.git-mark')).toHaveClass(/git-dir/)

  // Changes (the activity bar): three rows, read only, the count on its
  // icon and the branch with what waits to go.
  await expect(page.locator('.activity-badge')).toHaveAttribute('data-count', '3')
  await page.getByRole('button', { name: /^Changes/ }).click()
  await expect(panel.locator('.scm-branch')).toHaveText(/madetest-branch.*2 commits to push/)
  await expect(panel.locator('.scm-row')).toHaveCount(3)
  await expect(panel.locator('.scm-row button, .scm-msg')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/git-changes.png' })

  // A tap opens the diff; Diff shows the file and back.
  await panel.locator('.scm-row', { hasText: changed }).click()
  const view = page.locator('.diff-view')
  await expect(view.locator('.diff-del')).toHaveText(/old line/)
  await expect(view.locator('.diff-add')).toHaveText(/new line/)
  await expect(view.locator('.diff-gap').first()).toHaveText('top')
  await page.screenshot({ path: 'test-results/git-diff.png' })
  const diffBtn = page.locator('.file-head').getByRole('button', { name: 'Diff' })
  await expect(diffBtn).toHaveAttribute('aria-pressed', 'true')
  await diffBtn.click()
  await expect(view).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('new line')
  await diffBtn.click()
  await expect(view.locator('.diff-add')).toHaveText(/new line/)

  // A deleted file opens on its diff too, though it is gone from disk.
  await panel.locator('.scm-row', { hasText: 'madetest-gone.txt' }).click()
  await expect(page.locator('.diff-view:visible .diff-del')).toHaveText(/bye/)
  // A new folder opens like one in the explorer, its files new, each with
  // its diff; a second tap closes it.
  await panel.locator('.scm-row', { hasText: 'madetest-new' }).click()
  const insideRow = panel.locator('.scm-row', { hasText: 'madetest-inside.txt' })
  await expect(insideRow.locator('.scm-mark')).toHaveText('U')
  await insideRow.click()
  await expect(page.locator('.diff-view:visible .diff-add')).toHaveText(/all new/)
  await panel.locator('.scm-row', { hasText: 'madetest-new' }).first().click()
  await expect(insideRow).toHaveCount(0)

  // Changes in two repositories: a heading and a branch row each, and
  // paths from the repository's folder.
  two = true
  await page.reload()
  // The view sticks: the page comes back (as another project would open)
  // on Changes, not the file explorer.
  await expect(page.getByRole('button', { name: /^Changes/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.change-repo')).toHaveCount(2)
  await expect(panel.locator('.change-repo').nth(1)).toHaveText(/madetest-paper/)
  await expect(panel.locator('.scm-branch').nth(1)).toHaveText(/madetest-other/)
  await expect(panel.locator('.scm-row', { hasText: 'madetest-paper.tex' })).not.toContainText('madetest-sub')
  await page.screenshot({ path: 'test-results/git-repos.png' })

  // Back to the file explorer, with the sort buttons.
  await page.getByRole('button', { name: 'File explorer', exact: true }).click()
  await expect(panel.locator('.files-sort')).toBeVisible()
})

// Changes on a real repository, made for the check in a temporary folder
// with a bare one beside it as its remote: a change committed but not
// pushed shows as much as one only made, each opening on its diff against
// the remote.
test('changes on a real repository list what is not pushed', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the sidebar is a drawer on a phone; same code')
  test.setTimeout(120_000)
  const tmp = mkdtempSync(join(tmpdir(), 'madetest-scm-'))
  const dir = join(tmp, 'repo')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'remote.git')])
    mkdirSync(dir)
    g('init', '-q', '-b', 'main')
    g('config', 'user.name', 'madetest')
    g('config', 'user.email', 'madetest@example.invalid')
    g('config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    writeFileSync(join(dir, 'b.txt'), 'bee\n')
    g('add', '.')
    g('commit', '-q', '-m', 'madetest first')
    g('remote', 'add', 'origin', join(tmp, 'remote.git'))
    g('push', '-q', '-u', 'origin', 'main')

    await page.goto('/login?token=' + token)
    await page.request.post('/api/folders/open', { data: { path: dir } })
    opened.push(dir)
    // Home may send the page to the folder with the latest activity
    // instead (helpers.ts openSession); insist.
    const hash = '#/f/' + encodeURIComponent(dir)
    await page.goto('/' + hash)
    await page.waitForTimeout(400)
    if (new URL(page.url()).hash !== hash) await page.goto('/' + hash)
    const panel = page.locator('.explorer-panel')
    await page.getByRole('button', { name: /^Changes/ }).click()
    await expect(panel.locator('.scm-branch')).toHaveText(/main.*Up to date/, { timeout: 10_000 })
    await expect(panel.locator('.scm-row')).toHaveCount(0)

    // Committed and not pushed, then one more change on top, and a new file.
    writeFileSync(join(dir, 'a.txt'), 'one\ncommitted\n')
    g('commit', '-q', '-am', 'madetest local')
    writeFileSync(join(dir, 'b.txt'), 'bee\nnot yet\n')
    writeFileSync(join(dir, 'new.txt'), 'brand new\n')
    // No reload (the app may open the latest project instead): the panel
    // asks git again every few seconds.
    await expect(panel.locator('.scm-branch')).toHaveText(/main.*1 commit to push/, { timeout: 15_000 })
    await expect(panel.locator('.scm-row')).toHaveCount(3)
    await expect(panel.locator('.scm-row', { hasText: 'new.txt' }).locator('.scm-mark')).toHaveText('U')
    await page.screenshot({ path: 'test-results/scm-local.png' })

    // The committed change opens on its diff against the remote.
    await panel.locator('.scm-row', { hasText: 'a.txt' }).click()
    await expect(page.locator('.diff-view:visible .diff-add')).toHaveText(/committed/)
    await expect(page.locator('.diff-hunk button, .diff-bar')).toHaveCount(0)
  } finally {
    // Closed in the app first: on Windows a folder the server still has
    // open (its watcher, a git it ran) cannot be removed (EPERM).
    await page.goto('about:blank')
    await closeOpened({ page })
    // Only the folder mkdtemp made, checked by its marker.
    if (/madetest-scm-[^/\\]+$/.test(tmp)) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
