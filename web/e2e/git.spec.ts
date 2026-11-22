import { expect, test } from '@playwright/test'
import { closeOpened, openSession, token } from './helpers'

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
        repos: [{ path: '', branch: 'madetest-branch', ahead: 2 }, ...(two ? [{ path: 'madetest-sub/madetest-paper', branch: 'madetest-other' }] : [])],
        files: [
          { path: changed, st: 'M', repo: '' },
          { path: gone, st: 'D', repo: '' },
          { path: 'madetest-new/', st: 'U', repo: '' },
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
  await expect(panel.locator('.tree-row', { hasText: 'madetest-dir' }).locator('.git-mark')).toHaveText('•')

  // Changes: three rows, the count and the branch.
  await panel.getByRole('tab', { name: /CHANGES/ }).click()
  await expect(panel.locator('.side-count')).toHaveText('3')
  await expect(panel.locator('.branch')).toHaveText(/madetest-branch.*↑2/)
  await expect(panel.locator('.change-row')).toHaveCount(3)
  await page.screenshot({ path: 'test-results/git-changes.png' })

  // A tap opens the diff; Diff shows the file and back.
  await panel.locator('.change-row', { hasText: changed }).click()
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
  await panel.locator('.change-row', { hasText: 'madetest-gone.txt' }).click()
  await expect(page.locator('.diff-view:visible .diff-del')).toHaveText(/bye/)
  // A new folder opens like one in the explorer, its files new, each with
  // its diff; a second tap closes it.
  await panel.locator('.change-row', { hasText: 'madetest-new' }).click()
  const insideRow = panel.locator('.change-row', { hasText: 'madetest-inside.txt' })
  await expect(insideRow.locator('.git-mark')).toHaveText('U')
  await insideRow.click()
  await expect(page.locator('.diff-view:visible .diff-add')).toHaveText(/all new/)
  await panel.locator('.change-row', { hasText: 'madetest-new' }).first().click()
  await expect(insideRow).toHaveCount(0)

  // Changes in two repositories: a heading each, with its branch, and
  // paths from the repository's folder; the panel's own branch goes.
  two = true
  await page.reload()
  await panel.getByRole('tab', { name: /CHANGES/ }).click()
  await expect(panel.locator('.change-repo')).toHaveCount(2)
  await expect(panel.locator('.change-repo').nth(1)).toHaveText(/madetest-paper.*madetest-other/)
  await expect(panel.locator('.change-row', { hasText: 'madetest-paper.tex' })).not.toContainText('madetest-sub')
  await expect(panel.locator('.branch')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/git-repos.png' })

  // Back to the files, with the sort buttons.
  await panel.getByRole('tab', { name: 'FILES' }).click()
  await expect(panel.locator('.files-sort')).toBeVisible()
})
