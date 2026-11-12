import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react'
import { api, postJSON } from './api'
import { attachNow, ready, type Attachment } from './images'
import { noteProvider } from './local'
import { cacheLifeMs, useConfig } from './config'
import { windowFor } from './contextwindow'
import { aliasOf, ModelPicker, type Choice } from './ModelPicker'
import { SlashMenu, useSlashMenu, type Command } from './SlashMenu'
import { ago } from './route'
import { newPromptId, sendPrompt } from './send'
import { ackedSession, addPending, collapse, dropPending, filesChanged, refreshLists, updatePending, useStore } from './store'
import { tokens } from './Transcript'
import type { Session } from './types'

// The permission modes VS Code offers, by its names, plus Bypass. The chip
// shows the mode that will actually apply: what the session last ran with
// (its transcript says, whoever sent it), else the app's saved choice, else
// Auto. "Don't ask" (refuses what the rules do
// not allow; for scripts) is listed only when a session is already in it.
const modes: [string, string, string][] = [
  ['manual', 'Manual', 'Claude asks for approval before each edit'],
  ['acceptEdits', 'Edit automatically', 'Claude edits files without asking'],
  ['plan', 'Plan', 'Claude explores the code and presents a plan before editing'],
  ['auto', 'Auto', 'Claude approves actions that pass a safety check and pauses for anything risky'],
  ['bypassPermissions', 'Bypass permissions', 'Claude runs everything without asking'],
]
const dontAsk: [string, string, string] = ['dontAsk', "Don't ask", 'Claude refuses anything your permission rules do not allow']
// The same names stand for Codex's approval policy and sandbox pairs
// (the server maps them); edits inside the workspace never ask, so "Edit
// automatically" has no separate meaning there.
const codexModes: [string, string, string][] = [
  ['manual', 'Manual', 'Codex works in the project sandbox and asks before anything outside it'],
  ['plan', 'Plan', 'Codex only reads; any change asks first'],
  ['auto', 'Auto', "Codex's own reviewer approves safe actions and asks you about risky ones"],
  ['bypassPermissions', 'Bypass permissions', 'Codex runs everything, no sandbox, without asking'],
]
const codexDontAsk: [string, string, string] = ['dontAsk', "Don't ask", 'Codex refuses anything the project sandbox does not allow']

// The agent a new session starts with, remembered per browser.
const providerKey = 'dakort.provider'
const lastProvider = () => localStorage.getItem(providerKey) || 'claude'
// The same, kept current for the new-session tab's icon.
const providerListeners = new Set<() => void>()
export const useLastProvider = () =>
  useSyncExternalStore((l) => {
    providerListeners.add(l)
    return () => providerListeners.delete(l)
  }, lastProvider)

// "default" is the CLI's old name for "manual". Sending "default" would
// clear the session's choice on the server instead of choosing manual.
const realMode = (m?: string) => (m === 'default' ? 'manual' : m || '')

const draftKey = (key: string) => 'dakort.draft:' + key
// A draft's images, kept while the page lives: the composer goes with its
// tab, and a screenshot pasted before a visit to another session was gone
// on the way back. (Too big for localStorage, so a reload still loses them.)
const draftImages = new Map<string, Attachment[]>()

// On a phone, Return makes a new line; on a keyboard it sends.
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

// A queued message returned to the box (queue.go).
type TakenBack = { text: string; images?: { mediaType: string; data: string }[] }

// Files dropped on the session's pane come in here (SessionView).
export type FilesIn = MutableRefObject<((files: File[]) => void) | null>

type Props = {
  session?: Session // undefined for a session not started yet
  folder: string
  onStarted?: (id: string) => void
  filesIn?: FilesIn
}

export function Composer({ session, folder, onStarted, filesIn }: Props) {
  const id = session?.id ?? ''
  const key = id || 'new:' + folder
  const turn = useStore((s) => (id ? s.live.turns[id] : undefined))
  const queued = useStore((s) => (id ? s.live.queue[id] : undefined))
  const leftovers = useStore((s) => (id ? s.live.leftovers[id] : undefined))
  const context = useStore((s) => (id ? s.context[id] : 0))
  const [text, setText] = useState(() => localStorage.getItem(draftKey(key)) ?? '')
  const [images, setImages] = useState<Attachment[]>(() => draftImages.get(key) ?? [])
  const used = session?.used
  const fromSession = (): Choice => ({
    model: (used?.model ? aliasOf(used.model) : '') || session?.model || '',
    effort: session?.effort ?? '',
    ultracode: !!session?.ultracode,
    chrome: !!session?.chrome,
  })
  const [choice, setChoice] = useState<Choice>(fromSession)
  const [mode, setMode] = useState(used?.mode || session?.permissionMode || '')
  // A session with no mode of its own starts in Auto, whatever the Claude
  // settings say (by choice: the settings file keeps getting stale picks).
  const shownMode = realMode(mode) || 'auto'
  const cfg = useConfig()
  // Claude or Codex: a session's is fixed; a new one takes the last pick.
  const [provider, setProvider] = useState(session?.provider || lastProvider())
  const codex = provider === 'codex'
  const who = codex ? 'Codex' : 'Claude'
  const modeList = codex ? codexModes : modes
  const modeDontAsk = codex ? codexDontAsk : dontAsk
  const missing = cfg.clis?.find((c) => c.name === provider && !c.found)
  const [error, setError] = useState('')
  const [held, setHeld] = useState<{ pid: number; text: string; images: Attachment[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  // The "/" menu; a pick puts "/name " in the box, ready for arguments.
  const slash = useSlashMenu(folder, text, !codex)
  const pickCommand = (c: Command) => {
    setText('/' + c.name + ' ')
    box.current?.focus()
  }
  const file = useRef<HTMLInputElement>(null)
  // Windows 11 typing suggestions (and any IME) keep a composition
  // open at the end of the word being typed, and a Return then arrives
  // with isComposing set: handled as a plain Return it fell through to the
  // browser and made a new line, so a message at the end of its line
  // would not send. A Return during a composition now sends the moment
  // the composition ends (which that same Return brings about).
  const sendOnCompose = useRef(false)

  // Another device, or a terminal, may have changed what the session runs.
  // Each part on its own, so an effort saved below does not undo a model
  // picked and not yet sent.
  useEffect(() => setChoice((c) => ({ ...c, model: fromSession().model })), [used?.model, session?.model])
  useEffect(() => setChoice((c) => ({ ...c, effort: session?.effort ?? '', ultracode: !!session?.ultracode, chrome: !!session?.chrome })), [session?.effort, session?.ultracode, session?.chrome])
  // An effort, Ultracode or Chrome pick is the session's at once (a model goes with
  // the next send): kept only here, a tab switch or a reload lost it.
  const pickChoice = (c: Choice) => {
    setChoice(c)
    if (id && (c.effort !== choice.effort || c.ultracode !== choice.ultracode || c.chrome !== choice.chrome)) {
      postJSON(`/api/sessions/${id}/settings`, { effort: c.effort || 'default', ultracode: c.ultracode, chrome: c.chrome }).then(refreshLists, () => {})
    }
  }
  useEffect(() => setMode(used?.mode || session?.permissionMode || ''), [used?.mode, session?.permissionMode])
  useEffect(() => {
    if (session?.provider) setProvider(session.provider)
  }, [session?.provider])
  const pickProvider = (p: string) => {
    setProvider(p)
    localStorage.setItem(providerKey, p)
    providerListeners.forEach((l) => l())
    setChoice({ model: '', effort: '', ultracode: false, chrome: false }) // the other agent's models
    if (p === 'codex' && shownMode === 'acceptEdits') setMode('manual')
  }

  useEffect(() => {
    if (text) localStorage.setItem(draftKey(key), text)
    else localStorage.removeItem(draftKey(key))
  }, [key, text])
  useEffect(() => {
    if (images.length) draftImages.set(key, images)
    else draftImages.delete(key)
  }, [key, images])

  // Grow with the text, up to a third of the screen.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, window.innerHeight / 3) + 'px'
  }, [text])

  // The thumbnail shows at once; the shrunk copy that is sent takes its
  // place when ready (Send waits for it if need be).
  const addFiles = (files: Iterable<Blob>) => {
    for (const f of files) {
      const { item, done } = attachNow(f)
      setImages((cur) => [...cur, item])
      done.then(
        (a) => setImages((cur) => cur.map((x) => (x.url === a.url ? a : x))),
        (e) => {
          setImages((cur) => cur.filter((x) => x.url !== item.url))
          setError('Could not read the image: ' + (e instanceof Error ? e.message : e))
        },
      )
    }
  }
  // Any other file goes into the project folder, where the agent opens it
  // with its own tools; the box gets its path, in backticks, to point at
  // it. A taken name gets a number (upload.go), so the path says which.
  const [uploading, setUploading] = useState<string[]>([])
  const uploadFiles = async (files: File[]) => {
    for (const f of files) {
      setUploading((cur) => [...cur, f.name])
      try {
        const { path } = await api.upload(folder, f)
        setText((cur) => (cur && !/\s$/.test(cur) ? cur + ' ' : cur) + '`' + path + '` ')
        filesChanged()
      } catch (e) {
        setError(`Could not upload ${f.name}: ` + (e instanceof Error ? e.message : e))
      } finally {
        setUploading((cur) => {
          const i = cur.indexOf(f.name)
          return i < 0 ? cur : [...cur.slice(0, i), ...cur.slice(i + 1)]
        })
      }
    }
  }
  // Images the page can draw go with the message (the model sees them);
  // anything else, an SVG or a HEIC included, is uploaded.
  const takeFiles = (files: File[]) => {
    setError('')
    const isImage = (f: File) => /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(f.type)
    addFiles(files.filter(isImage))
    const other = files.filter((f) => !isImage(f))
    if (other.length) uploadFiles(other)
  }
  useEffect(() => {
    if (!filesIn) return
    filesIn.current = (files) => {
      takeFiles(files)
      box.current?.focus({ preventScroll: true })
    }
    return () => {
      filesIn.current = null
    }
  })

  const send = async (force = false, again?: { text: string; images: Attachment[] }) => {
    const t = again ? again.text : text.trim()
    const imgs = again ? again.images : images
    if ((!t && !imgs.length) || busy) return
    // Its path is not in the box yet, and the agent would not find the file.
    if (uploading.length) {
      setError('Wait for the upload to finish.')
      return
    }
    // While a turn runs the message waits on the server and goes when the
    // turn ends (queue.go), shown above the box meanwhile, not as sent.
    const queue = !!(id && turn)
    setError('')
    setHeld(null)
    setBusy(true)
    const promptId = newPromptId()
    if (!queue) addPending({ id: promptId, session: id, text: t, images: imgs.map((i) => i.url), at: Date.now() })
    // The box empties at once; a failure puts everything back.
    setText('')
    setImages([])
    // On a phone the keyboard goes once the send is under way (not on the
    // tap itself: see the Send button), leaving the screen to the reply.
    // With a mouse the box keeps (or gets back) the focus for the next line.
    if (coarse) box.current?.blur()
    else box.current?.focus()
    if (id && !queue) collapse(id)
    let full: Attachment[]
    try {
      full = await ready(imgs) // a just-pasted image may still be shrinking
    } catch (e) {
      setBusy(false)
      dropPending(promptId)
      setText((cur) => (cur ? cur + '\n\n' + t : t))
      setImages((cur) => [...imgs.filter((i) => i.data), ...cur])
      setError('Could not read the image: ' + (e instanceof Error ? e.message : e))
      return
    }
    const body: Record<string, unknown> & { promptId: string } = {
      promptId,
      text: t,
      images: full.map((i) => ({ mediaType: i.mediaType, data: i.data })),
    }
    // Always explicit: "default" clears what the session had remembered.
    body.model = choice.model || 'default'
    body.effort = choice.effort || 'default'
    body.ultracode = choice.ultracode
    body.chrome = choice.chrome
    body.permissionMode = shownMode // what the chip shows is what runs
    if (force) body.force = true
    if (queue) body.queue = true
    if (!id) {
      body.cwd = folder
      body.provider = provider
    }
    const r = await sendPrompt({
      url: id ? `/api/sessions/${id}/send` : '/api/sessions',
      body,
      acked: () => ackedSession(promptId),
    })
    setBusy(false)
    if (r.ok) {
      updatePending(promptId, { session: r.session })
      if (!id) {
        noteProvider(r.session, provider)
        onStarted?.(r.session)
      }
      refreshLists()
      return
    }
    // Keep the preview URLs alive: the attachments go back in the box.
    updatePending(promptId, { images: [] })
    dropPending(promptId)
    setText((cur) => (cur ? cur + '\n\n' + t : t))
    setImages((cur) => [...full, ...cur])
    if (r.kind === 'held') setHeld({ pid: r.heldBy, text: t, images: full })
    else setError(r.kind === 'auth' ? 'Not logged in on this device. Open the login link again.' : r.message)
    box.current?.focus()
  }

  // The tap is acknowledged at once; the turn's end (a few seconds when
  // the CLI is mid-tool) clears it. On a failure the button comes back.
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!turn) setStopping(false)
  }, [!turn])
  // A stop hands the queued messages back: they come into the box rather
  // than run after a turn stopped for going wrong.
  const stop = async () => {
    setStopping(true)
    try {
      const r = await postJSON<{ queued?: TakenBack[] }>(`/api/sessions/${id}/interrupt`, {})
      for (const q of r.queued ?? []) takeBack(q)
    } catch (e) {
      setStopping(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const takeBack = (q: TakenBack) => {
    if (q.text) setText((cur) => (cur.trim() ? cur.trimEnd() + '\n\n' + q.text : q.text))
    const imgs = (q.images ?? []).map((i) => ({ ...i, url: `data:${i.mediaType};base64,${i.data}`, size: i.data.length }))
    if (imgs.length) setImages((cur) => [...cur, ...imgs])
    box.current?.focus()
  }
  // A process a turn left running (leftovers.go) is ended only on request.
  const stopLeftover = async (pid: number) => {
    try {
      await postJSON(`/api/sessions/${id}/leftovers/${pid}/stop`, {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const unqueue = async (promptId: string) => {
    try {
      takeBack(await postJSON<TakenBack>(`/api/sessions/${id}/unqueue/${promptId}`, {}))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const sendHeld = () => {
    if (!held) return
    // The text went back into the box; send it from there, forced.
    const again = { text: text.trim(), images }
    send(true, again)
  }

  return (
    <div className="composer">
      {held && (
        <div className="notice warnbox">
          This session is open in another Claude process (pid {held.pid}). Sending now makes the two diverge: each
          continues its own branch of the transcript.
          <div className="row-buttons">
            <button className="btn" onClick={() => setHeld(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={sendHeld}>
              Send anyway
            </button>
          </div>
        </div>
      )}
      {missing && (
        <div className="notice error missing-cli">
          {who === 'Claude' ? 'Claude Code' : who} is not installed on this machine. In {missing.shell}, run{' '}
          <code>{missing.install}</code>, then run <code>{missing.signIn}</code> once to sign in, and reload this page.
        </div>
      )}
      {error && (
        <div className="notice error clickable" onClick={() => setError('')}>
          {error}
        </div>
      )}
      {id && <Tasks session={id} onError={setError} />}
      {leftovers?.length ? (
        <div className="queued leftovers">
          {leftovers.map((p) => (
            <div
              key={p.pid}
              className="queued-item"
              title={[p.command, p.dir && 'in ' + p.dir, p.started && 'since ' + new Date(p.started).toLocaleString()].filter(Boolean).join('\n')}
            >
              <span className="faint small">Still running</span>
              <span className="ellipsis grow">
                {p.name}
                {p.command ? <span className="faint"> · {p.command}</span> : null}
              </span>
              <span className="faint small">{ago(p.started)}</span>
              <button className="btn small-btn" onClick={() => stopLeftover(p.pid)} title="End this process">
                Stop
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {queued?.length ? (
        <div className="queued">
          {queued.map((q) => (
            <div key={q.promptId} className="queued-item" title={q.error ? `Not sent: ${q.error}. It goes after the next turn.` : 'Goes when the turn ends'}>
              <span className="faint small">{q.error ? 'Not sent' : 'Queued'}</span>
              <span className="ellipsis grow">
                {q.text}
                {q.images ? ` (+${q.images} image${q.images > 1 ? 's' : ''})` : ''}
              </span>
              <button className="tab-x" aria-label="Take back to the box" title="Take back to the box" onClick={() => unqueue(q.promptId)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {uploading.length > 0 && <div className="notice faint small uploading">Uploading {uploading.join(', ')} to the project folder…</div>}
      {images.length > 0 && (
        <div className="attachments">
          {images.map((im, i) => (
            <span key={im.url} className="attachment">
              <img src={im.url} alt="" />
              <button className="tab-x" aria-label="Remove image" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={'composer-box' + (session?.heldBy ? ' held' : '')}>
        <SlashMenu menu={slash} pick={pickCommand} />
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={id ? `Message ${who}` : 'Start a new session in this project'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && slash.onKey(e, pickCommand)) return
            if (e.key === 'Enter' && !e.shiftKey && !coarse) {
              e.preventDefault()
              if (e.nativeEvent.isComposing) sendOnCompose.current = true
              else send()
            }
          }}
          onCompositionEnd={() => {
            if (!sendOnCompose.current) return
            sendOnCompose.current = false
            // The box's own value: the state this render closed over
            // predates the commit.
            const cur = box.current
            setTimeout(() => {
              if (cur) send(false, { text: cur.value.trim(), images })
            }, 0)
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length) {
              e.preventDefault()
              takeFiles(files)
            }
          }}
        />
        <div className="composer-row">
          <button
            className="icon"
            aria-label="Attach files"
            title="Attach files: images go with the message, other files are uploaded to the project folder"
            onClick={() => file.current?.click()}
          >
            +
          </button>
          <input
            ref={file}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) takeFiles(Array.from(e.target.files))
              e.target.value = ''
            }}
          />
          {/* Which agent: a choice for a new session (when Codex is
              installed), a label on a Codex session. */}
          {!id && cfg.codex ? (
            <span className="chip mode-chip" title="Which agent runs this session">
              {who}
              <span className="caret">▾</span>
              <select value={provider} onChange={(e) => pickProvider(e.target.value)} aria-label="Agent">
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </span>
          ) : codex ? (
            <span className="chip">Codex</span>
          ) : null}
          <ModelPicker value={choice} onChange={pickChoice} provider={provider} />
          {id && !turn && !codex && <CacheClock session={id} idleCompact={session?.idleCompact !== false} />}
          {session?.heldBy || context ? (
            <span className="box-info">
              {session?.heldBy ? (
                <span
                  className="warn"
                  title={`Open in another Claude (pid ${session.heldBy}); sending from here makes the two diverge`}
                >
                  in another Claude
                </span>
              ) : null}
              {context ? <ContextSize session={id} context={context} model={used?.model} /> : null}
            </span>
          ) : null}
          <span className="grow" />
          {/* The chip shows the current mode's name and is as wide as it; the
              real dropdown lies invisibly on top (a bare select is as wide as
              its longest option), so a tap opens the native menu. */}
          <span className="chip mode-chip" title={[...modeList, modeDontAsk].find(([v]) => v === shownMode)?.[2]}>
            {[...modeList, modeDontAsk].find(([v]) => v === shownMode)?.[1] ?? shownMode}
            <span className="caret">▾</span>
            <select value={shownMode} onChange={(e) => setMode(e.target.value)} aria-label="Permission mode">
              {(shownMode === 'dontAsk' ? [...modeList, modeDontAsk] : modeList).map(([v, l, d]) => (
                <option key={v} value={v} title={d}>
                  {l}
                </option>
              ))}
            </select>
          </span>
          {turn && (
            <button className={'send stop' + (stopping ? ' stopping' : '')} onClick={stop} disabled={stopping} aria-label={stopping ? 'Stopping' : 'Stop'} title={stopping ? 'Stopping…' : 'Stop'}>
              ■
            </button>
          )}
          {/* During a turn, Send shows once there is something to queue. */}
          {(!turn || text.trim() || images.length > 0) && (
            <button
              className="send"
              // Keep the focus in the box: on a phone, a tap that took it
              // committed the word being typed and started the keyboard
              // closing, the layout moved under the finger, and the tap
              // missed until a Return had committed the word first (the
              // button was blue, so enabled). send closes the keyboard after.
              // With a mouse the click may take the focus: that ends any
              // composition (Windows typing suggestions) before the send reads
              // the box, and send puts the focus back.
              onMouseDown={(e) => {
                if (coarse) e.preventDefault()
              }}
              onClick={() => send()}
              disabled={busy || (!text.trim() && !images.length)}
              aria-label={turn ? 'Queue' : 'Send'}
              title={turn ? 'Queue: it goes when this turn ends' : 'Send'}
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// Tasks lists the session's background tasks (a command run in the
// background, a monitor), each with a stop. Claude is woken when one ends
// or a monitor prints; a stopped one ends quietly.
function Tasks({ session, onError }: { session: string; onError: (msg: string) => void }) {
  const tasks = useStore((s) => s.live.tasks[session])
  const [stopping, setStopping] = useState<string[]>([])
  if (!tasks?.length) return null
  const stop = async (task: string) => {
    setStopping((l) => [...l, task])
    try {
      await postJSON(`/api/sessions/${session}/tasks/${encodeURIComponent(task)}/stop`, {})
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setStopping((l) => l.filter((x) => x !== task))
    }
  }
  return (
    <div className="tasks">
      {tasks.map((k) => (
        <span key={k.id} className="task" title={`Running in the background: ${k.description || k.type}. Claude hears when it ends.`}>
          <span className="task-dot" />
          <span className="ellipsis">{k.description || k.type}</span>
          <button className="tab-x" aria-label="Stop this task" title="Stop" disabled={stopping.includes(k.id)} onClick={() => stop(k.id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

// ContextSize is the last call's context and, once the model's window is
// known (see contextwindow.ts), a bar against it: amber past 75%, red past
// 90%.
function ContextSize({ session, context, model }: { session: string; context: number; model?: string }) {
  const replyModel = useStore((s) => s.replyModel[session])
  const stated = useStore((s) => s.rowWindow[session]) ?? 0
  const win = windowFor(replyModel || model, stated)
  const pct = win ? Math.min(100, (context / win.tokens) * 100) : 0
  const level = pct >= 90 ? ' high' : pct >= 75 ? ' mid' : ''
  const title = win
    ? `Context: ${tokens(context)} of ${tokens(win.tokens)} tokens in the last call${win.assumed ? ' (window assumed)' : ''}`
    : `Context: ${tokens(context)} tokens in the last call`
  return (
    <span className="ctx" title={title}>
      {tokens(context)}
      {win && (
        <span className={'ctx-bar' + level} aria-hidden="true">
          <span className="ctx-fill" style={{ width: `max(2px, ${pct.toFixed(1)}%)` }} />
        </span>
      )}
    </span>
  )
}

// CacheClock counts down the prompt cache from Claude's last reply. Past
// it, the next message pays to read the whole context in again; tapping
// says how much that is, and holds the session's idle-compaction switch.
function CacheClock({ session, idleCompact }: { session: string; idleCompact: boolean }) {
  const cfg = useConfig()
  const last = useStore((s) => s.lastReply[session])
  const life = useStore((s) => s.cacheLife[session])
  const context = useStore((s) => s.context[session])
  const [now, setNow] = useState(Date.now())
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  // Close on a tap outside, as the model picker does.
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', off)
    return () => document.removeEventListener('pointerdown', off)
  }, [open])
  if (!last) return null
  const left = last + cacheLifeMs(cfg, life) - now
  const expired = left <= 0
  const mins = Math.ceil(left / 60_000)
  const label = expired ? 'cache expired' : mins > 1 ? `${mins}m` : '<1m'
  const tip = expired
    ? `The prompt cache has likely expired; the next message reads ${context ? `about ${tokens(context)} tokens` : 'the whole context'} in again.`
    : `The prompt cache stays warm for ${label} more; a message before then reuses it.`
  return (
    <span className="cache-wrap" ref={wrap}>
      <button className={'cache-clock' + (expired ? ' expired' : '')} onClick={() => setOpen(!open)} title={tip} aria-label={tip}>
        ◷ <span className="cache-text">{label}</span>
      </button>
      {open && (
        <span className="cache-tip small" onClick={() => setOpen(false)}>
          {tip}
          <span
            className="idle-row"
            onClick={(e) => {
              e.stopPropagation()
              postJSON(`/api/sessions/${session}/settings`, { idleCompact: !idleCompact }).then(refreshLists, () => {})
            }}
          >
            <span className="grow">
              Compact when idle
              <span className="idle-desc">Over 200k, about 5 minutes before the cache expires, so a later message reads a short summary.</span>
            </span>
            <span className={'switch' + (idleCompact ? ' on' : '')} role="switch" aria-checked={idleCompact} aria-label="Compact when idle" />
          </span>
        </span>
      )}
    </span>
  )
}
