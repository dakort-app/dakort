import { useEffect, useState } from 'react'
import { lastFolder } from './local'
import { OpenFolder } from './OpenFolder'
import { folderHash } from './route'
import { useStore } from './store'

// Home is not a page of its own: it goes straight to the folder last on
// screen, or the open folder with the latest activity. Switching, opening
// and closing folders all happen in the workspace's top bar. Only with no
// folder open is there something to show here.
export function Home() {
  const folders = useStore((s) => s.folders)
  const loaded = useStore((s) => s.loaded)
  const error = useStore((s) => s.error)
  const [picking, setPicking] = useState(false)

  const open = folders.filter((f) => f.open && !f.missing)
  const target = open.find((f) => f.path === lastFolder()) ?? [...open].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))[0]
  useEffect(() => {
    // replace, so the back button does not land here and bounce forward
    if (target) location.replace(folderHash(target.path))
  }, [target?.path])

  return (
    <div className="page">
      <header className="bar">
        <span className="brand">Dakort</span>
        <StreamDot />
      </header>
      {error && <p className="error pad">{error}</p>}
      {loaded && !target && (
        <div className="center">
          <p className="faint">No projects open.</p>
          <button className="btn primary" onClick={() => setPicking(true)}>
            Open project
          </button>
          <p className="faint hint">
            A project is a folder. Folders where Claude Code or Codex has run are listed first, with their sessions. Or pick any folder and
            start a session in it.
          </p>
        </div>
      )}
      {picking && <OpenFolder onClose={() => setPicking(false)} />}
    </div>
  )
}

export function StreamDot() {
  const st = useStore((s) => s.stream)
  return <span className={'dot ' + (st === 'open' ? 'ok' : 'warn')} title={st === 'open' ? 'connected' : 'reconnecting'} />
}
