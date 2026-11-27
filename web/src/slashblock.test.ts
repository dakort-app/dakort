import { expect, test } from 'vitest'
import { slashBlock } from './slashblock'

test('a terminal-only built-in is answered, with where to go instead', () => {
  expect(slashBlock('/model')).toContain('model chip')
  expect(slashBlock('/model opus ')).toContain('model chip')
  expect(slashBlock('/clear')).toContain('New session')
  expect(slashBlock('/config')).toContain('Run it in a terminal')
})

test('the commands that work, prose and skills are sent', () => {
  expect(slashBlock('/compact')).toBe('')
  expect(slashBlock('/models are fun')).toBe('')
  expect(slashBlock('what does /model do?')).toBe('')
  expect(slashBlock('/model', (n) => n === 'model')).toBe('')
})
