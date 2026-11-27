import { expect, test } from 'vitest'
import { commandLabel } from './cmdlabel'

test('a command reads as a few plain words, never itself', () => {
  expect(commandLabel('cd ~/Developer/x && git fetch -q origin && git merge-base --is-ancestor a b')).toBe('Run git commands')
  expect(commandLabel('git add -A && git commit -m "x" && git push origin main')).toBe('Commit and push')
  expect(commandLabel('git commit -q -m "x"')).toBe('Commit changes')
  expect(commandLabel('git -C repo status --short | head')).toBe('Look at git changes')
  expect(commandLabel('cd web && npx vitest run 2>&1 | tail -4')).toBe('Run unit tests')
  expect(commandLabel('DAKORT_URL=http://x npx playwright test -g "name"')).toBe('Run browser checks')
  expect(commandLabel('export PATH=$HOME/go/bin:$PATH && go test ./internal/server')).toBe('Run Go tests')
  expect(commandLabel('cd web && npx tsc --noEmit -p . && npx vite build')).toBe('Build the UI')
  expect(commandLabel('ls -la && cat README.md | head -20')).toBe('Look at files')
  expect(commandLabel("sed -n 1,40p src/a.ts; grep -n foo src/*.ts")).toBe('Look at files')
  expect(commandLabel('python3 - <<EOF\nprint(1)\nEOF')).toBe('Run a script')
  expect(commandLabel('npm install')).toBe('Install packages')
  expect(commandLabel('rm -f /tmp/x')).toBe('Delete files')
  expect(commandLabel('curl -s http://127.0.0.1:3003/api/config')).toBe('Fetch from the web')
})

test('anything else is "Run a command"', () => {
  expect(commandLabel('frobnicate --hard')).toBe('Run a command')
  expect(commandLabel('echo hi')).toBe('Run a command')
  expect(commandLabel('')).toBe('Run a command')
})
