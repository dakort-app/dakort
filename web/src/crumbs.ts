// crumbs splits a folder's path into the steps of a breadcrumb, each with
// the path it goes to: the root ("/", "C:"), then each folder. Windows
// paths keep their backslashes; a trailing separator adds no step.
export type Crumb = { label: string; path: string }

export function crumbs(path: string): Crumb[] {
  if (!path) return []
  const win = /^[a-z]:[\\/]?/i.exec(path)
  const sep = win || path.includes('\\') ? '\\' : '/'
  const root = win ? win[0].slice(0, 2) + sep : path.startsWith(sep) ? sep : ''
  const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean)
  const out: Crumb[] = root ? [{ label: win ? root.slice(0, 2) : '/', path: root }] : []
  let at = root
  for (const p of parts) {
    at = at && !at.endsWith(sep) ? at + sep + p : at + p
    out.push({ label: p, path: at })
  }
  return out
}
