import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Composer, type FilesIn } from './Composer'
import { PermissionCard } from './PermissionCard'
import { PromptText } from './PromptText'
import { showing, useStore } from './store'
import { Transcript } from './Transcript'
import type { Session } from './types'

// A session tab: the transcript, a permission question when the CLI asks
// one, and the composer. No title bar: the tab carries the title, and the
// context size and "in another Claude" sit in the composer, to leave the
// height to the transcript.
// id is empty for a session not started yet; session is missing until the
// list has it.
type Props = { id: string; session?: Session; folder: string; onStarted: (id: string) => void }

// Files dragged from the desktop carry "Files"; a tab or text dragged
// inside the page does not, and passes through untouched.
const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

export function SessionView({ id, session, folder, onStarted }: Props) {
  // Files dropped anywhere on the session (transcript or composer) attach
  // as the + button does (from a contributor's branch). Entering and leaving child
  // elements fire in pairs, hence the count.
  const filesIn: FilesIn = useRef(null)
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const drop = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth.current++
      setOver(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault() // or the browser opens the file in place of the app
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      if (--depth.current <= 0) {
        depth.current = 0
        setOver(false)
      }
    },
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      if (e.dataTransfer.files.length) filesIn.current?.(Array.from(e.dataTransfer.files))
    },
  }
  // On screen: a turn finishing here needs no notice.
  useEffect(() => showing(id), [id])
  const perms = useStore((s) => (id ? s.live.turns[id]?.permissions : undefined))
  // Select the map itself: a selector that builds a new array on every
  // call makes React re-render forever.
  const pending = useStore((s) => s.pending)
  const pendingNew = Object.values(pending).filter((p) => !p.session)
  return (
    <div className={'session' + (over ? ' drop-over' : '')} {...drop}>
      {id ? (
        <Transcript id={id} />
      ) : (
        <div className="transcript">
          {pendingNew.map((p) => (
            <div key={p.id} className="item-wrap">
              <div className="prompt pending">
                <PromptText text={p.text} />
              </div>
            </div>
          ))}
          {!pendingNew.length && <div className="center faint">A new session starts in {folder}.</div>}
        </div>
      )}
      {perms && perms.length > 0 && <PermissionCard key={perms[0].id} session={id} perm={perms[0]} more={perms.length - 1} />}
      <Composer key={id || 'new'} session={session ?? (id ? ({ id } as Session) : undefined)} folder={folder} onStarted={onStarted} filesIn={filesIn} />
      {over && (
        <div className="drop-veil" aria-hidden="true">
          <span>Drop images to attach</span>
        </div>
      )}
    </div>
  )
}
