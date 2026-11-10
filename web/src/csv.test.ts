import { describe, expect, it } from 'vitest'
import { parse, sniff } from './csv'

describe('reading CSV', () => {
  it('splits rows and fields, CRLF or LF, with or without a last line break', () => {
    expect(parse('a,b\r\n1,2\r\n', ',').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(parse('a,b\n1,2', ',').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps delimiters, quotes and line breaks inside quotes', () => {
    expect(parse('name,note\n"Smith, J","said ""hi""\nthen left"\n', ',').rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\nthen left'],
    ])
  })

  it('keeps empty fields and drops a byte order mark', () => {
    expect(parse('﻿a,,c\n,,\n', ',').rows).toEqual([['a', '', 'c'], ['', '', '']])
  })

  it('stops at maxRows and says there is more', () => {
    const r = parse('h\n1\n2\n3\n', ',', 2)
    expect(r.rows).toEqual([['h'], ['1']])
    expect(r.more).toBe(true)
    expect(parse('h\n1\n', ',', 2).more).toBe(false)
  })

  it('reads tabs', () => {
    expect(parse('a\tb\n1\t2', '\t').rows).toEqual([['a', 'b'], ['1', '2']])
  })
})

describe('guessing the delimiter', () => {
  it('takes the commonest of the first line, outside quotes', () => {
    expect(sniff('a,b,c\n1,2,3')).toBe(',')
    expect(sniff('a;b;c\n1,5;2,5;3')).toBe(';')
    expect(sniff('a\tb\n1\t2')).toBe('\t')
    expect(sniff('"x;y;z",b\n')).toBe(',')
    expect(sniff('single')).toBe(',')
  })
})
