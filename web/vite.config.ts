/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { FILE_ICON_NAMES, GENERIC } from './src/fileicons'

// Icons from two open sets, cut out at build time so the bundle carries
// only the ones used (the sets' JSON is megabytes): file types from
// Material Icon Theme (MIT, @iconify-json/material-icon-theme) and the
// Claude and OpenAI marks from Simple Icons (CC0, @iconify-json/simple-icons).
// The app imports them as virtual:icons.
function icons(): Plugin {
  const id = 'virtual:icons'
  type Box = { left?: number; top?: number; width?: number; height?: number }
  type Set = Box & { icons: Record<string, Box & { body: string }>; aliases?: Record<string, { parent: string }> }
  const load = (pkg: string): Set => JSON.parse(readFileSync(createRequire(import.meta.url).resolve(pkg + '/icons.json'), 'utf8'))
  const pick = (set: Set, name: string) => {
    const icon = set.icons[name] ?? set.icons[set.aliases?.[name]?.parent ?? '']
    if (!icon) throw new Error('no icon ' + name)
    // The view box: some icons start off the origin (Material's json at top -960).
    const box = [icon.left ?? set.left ?? 0, icon.top ?? set.top ?? 0, icon.width ?? set.width ?? 16, icon.height ?? set.height ?? 16]
    return { body: icon.body, box: box.join(' ') }
  }
  return {
    name: 'made-icons',
    resolveId: (i) => (i === id ? '\0' + id : undefined),
    load(i) {
      if (i !== '\0' + id) return
      const material = load('@iconify-json/material-icon-theme')
      const simple = load('@iconify-json/simple-icons')
      const files: Record<string, { body: string; box: string }> = {}
      for (const n of FILE_ICON_NAMES) files[n] = pick(material, n)
      // The generic file: Material's document in the grey its theme uses
      // for files it does not know.
      const doc = pick(material, 'document')
      files[GENERIC] = { ...doc, body: doc.body.replace(/#42a5f5/g, '#90a4ae') }
      const brands = { claude: pick(simple, 'claude'), openai: pick(simple, 'openai') }
      return `export const fileIcons = ${JSON.stringify(files)}\nexport const brandIcons = ${JSON.stringify(brands)}\n`
    },
  }
}

// The build goes straight into the Go server's embedded folder, with fixed
// names: the server sends no cache headers, so hashed names would buy
// nothing and churn every commit. `npm run dev` proxies the API to a
// server on 3002 (the fork holds 3001 on this laptop).
export default defineConfig({
  plugins: [react(), icons()],
  build: {
    outDir: '../internal/server/ui',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        // KaTeX brings its own CSS and fonts, so assets keep their names.
        assetFileNames: '[name][extname]',
      },
    },
  },
  // Unit tests only; the phone checks in e2e/ run under Playwright.
  test: { include: ['src/**/*.test.ts'] },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3002',
      '/login': 'http://127.0.0.1:3002',
    },
  },
})
