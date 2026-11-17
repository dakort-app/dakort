import { describe, expect, it } from 'vitest'
import { cssColour, defaultTheme, formatDate, formatNumber, formatValue, plainValue, themeColours, tint } from './sheetfmt'

describe('number formats', () => {
  it('General keeps integers whole and trims long floats', () => {
    expect(formatNumber(42, 'General')).toBe('42')
    expect(formatNumber(0.1 + 0.2, '')).toBe('0.3')
    expect(formatNumber(-3.5, 'General')).toBe('-3.5')
  })
  it('fixed decimals, thousands and percent', () => {
    expect(formatNumber(1234.5, '0.00')).toBe('1234.50')
    expect(formatNumber(1234.5, '#,##0.00')).toBe('1,234.50')
    expect(formatNumber(1234567, '#,##0')).toBe('1,234,567')
    expect(formatNumber(0.125, '0%')).toBe('13%')
    expect(formatNumber(0.125, '0.0%')).toBe('12.5%')
    expect(formatNumber(1234.5, '$#,##0.00')).toBe('$1,234.50')
  })
  it('negative sections drop the minus, as Excel shows them', () => {
    expect(formatNumber(-5, '0.00;(0.00)')).toBe('(5.00)')
    expect(formatNumber(5, '0.00;(0.00)')).toBe('5.00')
    expect(formatNumber(0, '0;-0;"zero"')).toBe('zero')
  })
  it('scientific', () => {
    expect(formatNumber(12345, '0.00E+00')).toBe('1.23E+04')
    expect(formatNumber(0.00012, '0.0E+00')).toBe('1.2E-04')
  })
  it('quoted text and colour codes are not digits', () => {
    expect(formatNumber(3, '[Red]0" items"')).toBe('3 items')
    expect(formatNumber(2.5, '0.0 "kg"')).toBe('2.5 kg')
  })
})

describe('dates', () => {
  const d = new Date(Date.UTC(2026, 10, 16, 9, 5, 7)) // 16 Nov 2026 09:05:07
  it('date tokens', () => {
    expect(formatDate(d, 'yyyy-mm-dd')).toBe('2026-11-16')
    expect(formatDate(d, 'd mmm yyyy')).toBe('16 Nov 2026')
    expect(formatDate(d, 'dddd, mmmm d')).toBe('Monday, November 16')
    expect(formatDate(d, 'dd/mm/yy')).toBe('16/11/26')
  })
  it('tells minutes from months by the hour or second beside them', () => {
    expect(formatDate(d, 'hh:mm:ss')).toBe('09:05:07')
    expect(formatDate(d, 'h:mm AM/PM')).toBe('9:05 AM')
    expect(formatDate(d, 'yyyy-mm-dd hh:mm')).toBe('2026-11-16 09:05')
    expect(formatDate(d, 'mm:ss')).toBe('05:07')
  })
  it('a Date value with no date format shows ISO; a serial with a date format is a date', () => {
    expect(formatValue(d, 'General')).toBe('2026-11-16')
    expect(formatValue(d, 'mmm d')).toBe('Nov 16')
    expect(formatNumber(46342, 'yyyy-mm-dd')).toBe('2026-11-16')
  })
})

describe('colours', () => {
  it('argb, with a transparent one meaning none', () => {
    expect(cssColour({ argb: 'FFFFF2CC' })).toBe('#FFF2CC')
    expect(cssColour({ argb: '00000000' })).toBe('')
    expect(cssColour({ argb: 'FFF2CC' })).toBe('#FFF2CC')
  })
  it('indexed palette', () => {
    expect(cssColour({ indexed: 23 })).toBe('#808080')
    expect(cssColour({ indexed: 10 })).toBe('#FF0000')
    expect(cssColour({ indexed: 64 })).toBe('')
  })
  it('theme with tint', () => {
    expect(cssColour({ theme: 1 })).toBe('#000000')
    expect(cssColour({ theme: 0 })).toBe('#FFFFFF')
    expect(cssColour({ theme: 4 })).toBe('#4472C4')
    expect(cssColour({ theme: 1, tint: 0.5 })).toBe('#808080')
    expect(cssColour({ theme: 0, tint: -0.15 })).toBe('#D9D9D9')
    expect(cssColour({ theme: 20 })).toBe('')
  })
  it('tint keeps the hue', () => {
    expect(tint('4472C4', 0)).toBe('4472C4')
    expect(tint('4472C4', 0.8).toLowerCase()).toBe('dae3f3')
  })
  it('reads a theme part', () => {
    const xml = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="X">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1F3864"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
      <a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`
    const t = themeColours(xml)
    expect(t[0]).toBe('FFFFFF')
    expect(t[1]).toBe('000000')
    expect(t[3]).toBe('1F3864')
    expect(t[4]).toBe('FF0000')
    expect(t[5]).toBe(defaultTheme[5]) // not in the scheme: Office's
    expect(themeColours(undefined)).toEqual(defaultTheme)
  })
})

describe('cell values', () => {
  it('plain, rich text, hyperlink, error, formula', () => {
    expect(plainValue('a')).toEqual({ value: 'a' })
    expect(plainValue({ richText: [{ text: 'a' }, { text: 'b', font: { bold: true } }] })).toEqual({ value: 'ab' })
    expect(plainValue({ text: 'site', hyperlink: 'https://x' })).toEqual({ value: 'site' })
    expect(plainValue({ error: '#N/A' })).toEqual({ value: '#N/A' })
    expect(plainValue({ formula: 'A1+1', result: 3 })).toEqual({ value: 3 })
    expect(plainValue({ sharedFormula: 'A1', result: 'x' })).toEqual({ value: 'x' })
    expect(plainValue({ formula: 'SUM(A1:A2)' })).toEqual({ value: null, formulaNoResult: true })
  })
  it('formatValue', () => {
    expect(formatValue(null, '0')).toBe('')
    expect(formatValue(true, undefined)).toBe('TRUE')
    expect(formatValue('x', '0.00')).toBe('x')
    expect(formatValue(2, '0.00')).toBe('2.00')
  })
})
