import { describe, expect, it } from 'vitest'
import { fold } from './fold'

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('folding a long prompt', () => {
  it('leaves a short prompt alone', () => {
    expect(fold('fix the bug')).toBeNull()
    expect(fold(numbered(15))).toBeNull()
  })

  it('shows the first six lines and the last two of a long paste', () => {
    const f = fold('Read this:\n' + numbered(199))!
    expect(f.head).toBe('Read this:\n' + numbered(5))
    expect(f.tail).toBe('line 198\nline 199')
    expect(f.hidden).toBe('192 more lines')
  })

  it('cuts a paste without line breaks by length, at a space', () => {
    const words = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ')
    const f = fold(words)!
    expect(f.head.length).toBeLessThanOrEqual(600)
    expect(f.head.endsWith(' ')).toBe(false)
    expect(words.startsWith(f.head)).toBe(true)
    expect(f.tail).toBe('')
    expect(f.hidden).toMatch(/more characters$/)
  })

  it('keeps a question typed after a one-line paste', () => {
    const paste = 'x'.repeat(3000)
    const f = fold(paste + '\n\nwhat do you think?')!
    expect(f.tail).toBe('what do you think?')
    expect(f.head.length).toBe(600)
  })
})
