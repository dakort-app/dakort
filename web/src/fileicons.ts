// Which icon a file gets, by its name. The icons are Material Icon Theme's
// (MIT, the VS Code extension's file icons), taken from
// @iconify-json/material-icon-theme at build time: vite.config.ts puts only
// the names listed here into the bundle (virtual:file-icons), never the
// whole set. Pure, so it can be tested without a DOM.

// By whole file name (lower case), checked first.
const byName: Record<string, string> = {
  'go.mod': 'go-mod',
  'go.sum': 'go-mod',
  'go.work': 'go-mod',
  'package.json': 'npm',
  'package-lock.json': 'npm',
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  makefile: 'makefile',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  license: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  'readme.md': 'readme',
  readme: 'readme',
  '.env': 'settings',
}

// By extension (lower case, without the dot).
const byExt: Record<string, string> = {
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  doc: 'word',
  docx: 'word',
  odt: 'word',
  rtf: 'word',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  csv: 'table',
  tsv: 'table',
  xls: 'table',
  xlsx: 'table',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  heic: 'image',
  tif: 'image',
  tiff: 'image',
  svg: 'svg',
  go: 'go',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'react',
  jsx: 'react',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  ipynb: 'jupyter',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'settings',
  cfg: 'settings',
  conf: 'settings',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'sass',
  sass: 'sass',
  less: 'less',
  xml: 'xml',
  tex: 'tex',
  sty: 'tex',
  cls: 'tex',
  bib: 'bibliography',
  sh: 'console',
  bash: 'console',
  zsh: 'console',
  fish: 'console',
  bat: 'console',
  cmd: 'console',
  ps1: 'powershell',
  psm1: 'powershell',
  c: 'c',
  h: 'h',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cu: 'cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  r: 'r',
  jl: 'julia',
  vue: 'vue',
  svelte: 'svelte',
  sql: 'database',
  db: 'database',
  sqlite: 'database',
  zip: 'zip',
  tar: 'zip',
  gz: 'zip',
  tgz: 'zip',
  '7z': 'zip',
  rar: 'zip',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  ogg: 'audio',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  lock: 'lock',
  log: 'log',
  txt: 'document',
}

// The generic icon: Material's document, in its grey (made in vite.config.ts).
export const GENERIC = 'file'

// Every icon the app can ask for, for the build to extract.
export const FILE_ICON_NAMES = [...new Set([...Object.values(byName), ...Object.values(byExt), 'readme', 'license', 'docker', 'settings', 'vite', 'document'])]

// fileIconName picks the icon for a path or file name.
export function fileIconName(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase()
  if (byName[name]) return byName[name]
  if (/^readme\b/.test(name)) return 'readme'
  if (/^license\b/.test(name)) return 'license'
  if (/^dockerfile\b/.test(name)) return 'docker'
  if (/^\.env\b/.test(name)) return 'settings'
  if (/^vite\.config\./.test(name)) return 'vite'
  const dot = name.lastIndexOf('.')
  return (dot >= 0 && byExt[name.slice(dot + 1)]) || GENERIC
}
