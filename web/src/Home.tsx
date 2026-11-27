import { useEffect, useState, type ReactNode } from 'react'
import { lastFolder } from './local'
import { type Fault, OpenFolder, Problem, ProjectRow, openProject } from './OpenFolder'
import { baseName, folderHash } from './route'
import { refreshLists, useStore } from './store'
import { Devices } from './Devices'
import { DevicesIcon, MoonIcon } from './icons'
import { isDark, setDark } from './theme'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Home is not a page of its own: it goes straight to the folder last on
// screen, or the open folder with the latest activity. Switching, opening
// and closing folders all happen in the workspace's sidebar. Only with no
// folder open is there something to show here: a page with the projects
// worked in lately, one tap from open, and the button for any other.
export function Home() {
  const folders = useStore((s) => s.folders)
  const sessions = useStore((s) => s.sessions)
  const loaded = useStore((s) => s.loaded)
  const error = useStore((s) => s.error)
  const [picking, setPicking] = useState(false)
  const [err, setErr] = useState<Fault | null>(null)
  const [devices, setDevices] = useState(false)
  const [dark, setDarkState] = useState(isDark)

  const open = folders.filter((f) => f.open && !f.missing)
  const target = open.find((f) => f.path === lastFolder()) ?? [...open].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))[0]
  useEffect(() => {
    // replace, so the back button does not land here and bounce forward
    if (target) location.replace(folderHash(target.path))
  }, [target?.path])

  const recent = folders
    .filter((f) => !f.open && !f.missing)
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
    .slice(0, 5)
  const pick = (path: string) => openProject(path).catch((e) => setErr({ title: 'Could not open that project.', why: String(e instanceof Error ? e.message : e) }))

  return (
    <div className="page home">
      {/* No sidebar here, so its foot's two settings sit at the bar's end. */}
      <HomeBar>
        <span className="grow" />
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={() => setDevices(true)} aria-label="Other devices" title="Other devices">
          <DevicesIcon />
        </Button>
        <Button variant="ghost" size="icon-sm"
          className={cn('text-muted-foreground hover:text-foreground', (dark) && 'on')}
          onClick={() => {
            setDark(!dark)
            setDarkState(!dark)
          }}
          aria-label="Dark mode"
          aria-pressed={dark}
          title="Dark mode"
        >
          <MoonIcon />
        </Button>
      </HomeBar>
      <StreamBanner />
      {!loaded && !error && <div className="center faint">Loading…</div>}
      {/* A list that will not load leaves the page usable: Open project
          browses the disk without it. */}
      {(loaded || error) && !target && (
        <main className="home-main">
          <h1 className="home-title">Open a project</h1>
          <p className="home-hint">Pick a folder. The ones Claude Code or Codex worked in come first.</p>
          {error && <Problem title="Could not list your projects." why={error} retry={() => refreshLists()} className="home-problem" />}
          {recent.length > 0 && (
            <ul className="list home-recent" aria-label="Recent projects">
              {recent.map((f) => (
                <ProjectRow key={f.path} f={f} latest={sessions.find((s) => s.folder === f.path)} showPath={recent.some((g) => g !== f && baseName(g.path) === baseName(f.path))} onPick={pick} />
              ))}
            </ul>
          )}
          {err && <Problem {...err} className="home-problem" />}
          <Button variant="default" size="sm" className="home-open" onClick={() => setPicking(true)}>
            Open project
          </Button>
        </main>
      )}
      {picking && <OpenFolder onClose={() => setPicking(false)} />}
      {devices && <Devices onClose={() => setDevices(false)} />}
    </div>
  )
}

// The bar atop a page of its own (home, not logged in): the mark on its
// lime tile and the name, and what the page puts at its end.
export function HomeBar({ children }: { children?: ReactNode }) {
  return (
    <header className="bar home-bar">
      <img src="/favicon.svg" alt="" width={20} height={20} />
      <span className="brand">Dakort</span>
      {children}
    </header>
  )
}

// The connection's state, as a marker a check can read (dot ok or warn,
// never shown): StreamBanner is what a person sees. A dot beside the
// buttons read as a stray mark, and a tap on it opened a new session
// (WebKit sends a tap to the nearest button).
export function StreamDot() {
  const st = useStore((s) => s.stream)
  return <span className={'dot ' + (st === 'open' ? 'ok' : 'warn')} hidden />
}

// StreamBanner says so in words once the stream has been down for a
// moment (the page's first connect, or a quick blip, says nothing):
// before, the only sign was the dot turning amber, and only in its tooltip
// did it say "reconnecting". Sending is left as it is.
export function StreamBanner() {
  const st = useStore((s) => s.stream)
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (st === 'open' || st === 'auth') return setLate(false)
    const t = window.setTimeout(() => setLate(true), 1500)
    return () => clearTimeout(t)
  }, [st])
  if (!late || st === 'open' || st === 'auth') return null
  return (
    <div className="stream-banner" role="status">
      <span className="ring" aria-hidden="true" />
      Reconnecting… What you type is kept.
    </div>
  )
}
