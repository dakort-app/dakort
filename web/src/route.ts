// Navigation by the URL hash, so the phone's back button works without a
// router: #/ is home, #/f/<folder> a workspace.

import { useSyncExternalStore } from 'react'

export type Route = { page: 'home' } | { page: 'folder'; folder: string }

export function parseRoute(hash: string): Route {
  const m = /^#\/f\/(.+)$/.exec(hash)
  if (m) {
    try {
      return { page: 'folder', folder: decodeURIComponent(m[1]) }
    } catch {
      // a mangled address; go home
    }
  }
  return { page: 'home' }
}

export const folderHash = (folder: string) => '#/f/' + encodeURIComponent(folder)

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (l) => {
      window.addEventListener('hashchange', l)
      return () => window.removeEventListener('hashchange', l)
    },
    () => location.hash,
  )
  return parseRoute(hash)
}

// baseName is a folder's last part, for titles.
export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export function parentPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  parts.pop()
  return parts.join(p.includes('\\') ? '\\' : '/')
}

// ago is a short relative time: "now", "5m", "3h", "2d", or a date.
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!t) return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
