import { describe, expect, it } from 'vitest'
import { latestTitle, titles } from './thinking'

describe('thinking titles', () => {
  it('lists the bold title lines of a summary', () => {
    const text =
      '**Reviewing sentence structure for clarity**\n\nI should read the abstract first.\n\n**Refining phrase clarity and tone**\n\nThe second sentence is long.'
    expect(titles(text)).toEqual(['Reviewing sentence structure for clarity', 'Refining phrase clarity and tone'])
  })

  it('finds none in plain text', () => {
    expect(titles('I need to read the file first, then edit it.')).toEqual([])
    expect(titles('')).toEqual([])
  })

  it('ignores bold inside a sentence', () => {
    const text = 'This is **important** to check.\n\n**Checking the build**\n\nRun it once.'
    expect(titles(text)).toEqual(['Checking the build'])
  })

  it('keeps a title with text before it', () => {
    expect(titles('Some preamble.\n\n  **Planning the edit**  \n\nBody.')).toEqual(['Planning the edit'])
  })

  it('takes the last complete title while streaming', () => {
    expect(latestTitle('**Reading the file**\n\nIt is short.\n\n**Drafting the')).toBe('Reading the file')
    expect(latestTitle('**Reading the file**\n\nIt is short.\n\n**Drafting the abstract**')).toBe('Drafting the abstract')
    expect(latestTitle('no titles here')).toBeUndefined()
  })
})
