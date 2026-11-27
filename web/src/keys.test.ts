import { expect, test } from 'vitest'
import { keyLabel } from './keys'

test('a shortcut reads the Mac way on a Mac', () => {
  expect(keyLabel('Ctrl+`', true)).toBe('⌃`')
  expect(keyLabel('Mod+F', true)).toBe('⌘F')
  expect(keyLabel('Alt+C', true)).toBe('⌥C')
  expect(keyLabel('Shift+Enter', true)).toBe('⇧↩')
  expect(keyLabel('Esc', true)).toBe('Esc')
})

test('and with words and pluses elsewhere', () => {
  expect(keyLabel('Ctrl+`', false)).toBe('Ctrl+`')
  expect(keyLabel('Mod+S', false)).toBe('Ctrl+S')
  expect(keyLabel('Shift+Enter', false)).toBe('Shift+Enter')
  expect(keyLabel('Ctrl++', false)).toBe('Ctrl++')
  expect(keyLabel('Esc', false)).toBe('Esc')
})
