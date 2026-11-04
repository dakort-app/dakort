import { describe, expect, it } from 'vitest'
import { tableWindow, windowFor } from './contextwindow'

describe('context window', () => {
  it('takes what a turn reported over the table', () => {
    expect(windowFor('claude-opus-4-6', 0, { 'claude-opus-4-6': 1_000_000 })).toEqual({ tokens: 1_000_000, assumed: false })
    expect(windowFor('claude-haiku-4-5-20251001', 0, { 'claude-haiku-4-5': 200_000 })).toEqual({ tokens: 200_000, assumed: false })
  })
  it('uses the measured table until then', () => {
    expect(windowFor('claude-opus-5-5', 0, {})).toEqual({ tokens: 1_000_000, assumed: false })
    expect(windowFor('claude-sonnet-4-6', 0, {})).toEqual({ tokens: 200_000, assumed: false })
    expect(windowFor('claude-haiku-4-5-20251001', 0, {})).toEqual({ tokens: 200_000, assumed: false })
    expect(tableWindow('claude-sonnet-4-6[1m]')).toEqual({ tokens: 1_000_000, assumed: false })
  })
  it('marks a guess as assumed, and does not guess for other agents', () => {
    expect(tableWindow('claude-opus-6')).toEqual({ tokens: 1_000_000, assumed: true })
    expect(tableWindow('claude-3-5-sonnet-20241022')).toEqual({ tokens: 200_000, assumed: true })
    expect(windowFor('gpt-5.6-sol', 0, {})).toBeNull()
    expect(windowFor('', 0, {})).toBeNull()
    expect(windowFor('gpt-5.6-sol', 0, { 'gpt-5.6-sol': 258_400 })).toEqual({ tokens: 258_400, assumed: false })
  })
  it('takes the window a transcript states before the table', () => {
    expect(windowFor('gpt-5.6-sol', 258_400, {})).toEqual({ tokens: 258_400, assumed: false })
    expect(windowFor('', 258_400, {})).toEqual({ tokens: 258_400, assumed: false })
    expect(windowFor('gpt-5.6-sol', 258_400, { 'gpt-5.6-sol': 272_000 })).toEqual({ tokens: 272_000, assumed: false })
  })
})
