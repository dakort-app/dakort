import { expect, test } from 'vitest'
import { crumbs } from './crumbs'

test('a path is its steps, each going to its own folder', () => {
  expect(crumbs('/Users/jo/Developer')).toEqual([
    { label: '/', path: '/' },
    { label: 'Users', path: '/Users' },
    { label: 'jo', path: '/Users/jo' },
    { label: 'Developer', path: '/Users/jo/Developer' },
  ])
  expect(crumbs('/')).toEqual([{ label: '/', path: '/' }])
  expect(crumbs('/a/b/')).toEqual([{ label: '/', path: '/' }, { label: 'a', path: '/a' }, { label: 'b', path: '/a/b' }])
})

test('a Windows path keeps its drive and backslashes', () => {
  expect(crumbs('C:\\Users\\jo')).toEqual([
    { label: 'C:', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'jo', path: 'C:\\Users\\jo' },
  ])
  expect(crumbs('D:\\')).toEqual([{ label: 'D:', path: 'D:\\' }])
})
