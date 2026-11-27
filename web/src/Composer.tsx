import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react'
import { api, postJSON } from './api'
import { attachNow, ready, type Attachment } from './images'
import { noteProvider } from './local'
import { cacheLifeMs, useConfig } from './config'
import { windowFor } from './contextwindow'
import { aliasOf, modelLabel, ModelPicker, type Choice } from './ModelPicker'
import { MenuOption, PopMenu } from './PopMenu'
import { SlashMenu, useSlashMenu, type Command } from './SlashMenu'
import { slashBlock } from './slashblock'
import { ago } from './route'
import { newPromptId, sendPrompt } from './send'
import { ackedSession, addPending, collapse, dropPending, filesChanged, refreshLists, updatePending, useStore } from './store'
import { tokens } from './Transcript'
import { Cross, ErrorMark } from './ToolView'
import { Icon } from './icons'
import type { Session, Task } from './types'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'

// The permission modes VS Code offers, by its names, plus Bypass. The chip
// shows the mode that will actually apply: what the session last ran with
// (its transcript says, whoever sent it), else the app's saved choice, else
// Auto. "Don't ask" (refuses what the rules do
// not allow; for scripts) is listed only when a session is already in it.
const modes: [string, string, string][] = [
  ['manual', 'Manual', 'Claude asks for approval before each edit'],
  ['acceptEdits', 'Edit automatically', 'Claude edits files without asking'],
  ['plan', 'Plan', 'Claude explores the code and presents a plan before editing'],
  ['auto', 'Auto', 'Claude approves safe actions and pauses for risky ones'],
  ['bypassPermissions', 'Bypass permissions', 'Claude runs everything without asking'],
]
const dontAsk: [string, string, string] = ['dontAsk', "Don't ask", 'Claude refuses anything your permission rules do not allow']
// The same names stand for Codex's approval policy and sandbox pairs
// (the server maps them); edits inside the workspace never ask, so "Edit
// automatically" has no separate meaning there.
const codexModes: [string, string, string][] = [
  ['manual', 'Manual', 'Codex works in the project sandbox and asks before anything outside it'],
  ['plan', 'Plan', 'Codex only reads; any change asks first'],
  ['auto', 'Auto', "Codex's reviewer approves safe actions and asks about risky ones"],
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
const rememberProvider = (p: string) => {
  localStorage.setItem(providerKey, p)
  providerListeners.forEach((l) => l())
}

// "default" is the CLI's old name for "manual". Sending "default" would
// clear the session's choice on the server instead of choosing manual.
const realMode = (m?: string) => (m === 'default' ? 'manual' : m || '')
// The chip's name on a phone, where the toolbar has one row for all.
const shortMode: Record<string, string> = { manual: 'Ask', acceptEdits: 'Edits', plan: 'Plan', auto: 'Auto', bypassPermissions: 'Bypass', dontAsk: "Don't ask" }

const draftKey = (key: string) => 'dakort.draft:' + key
// A draft's images, kept while the page lives: the composer goes with its
// tab, and a screenshot pasted before a visit to another session was gone
// on the way back. (Too big for localStorage, so a reload still loses them.)
const draftImages = new Map<string, Attachment[]>()

// The model a new session was sent with. Its pane mounts a fresh Composer
// before the session list knows the session, and that one would show the
// default (Opus) until the list caught up, though the turn ran the pick.
const startedModel = new Map<string, string>()

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
    model: (used?.model ? aliasOf(used.model) : '') || session?.model || startedModel.get(id) || '',
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
  const allModes = [...modeList, modeDontAsk]
  const missing = cfg.clis?.find((c) => c.name === provider && !c.found)
  const [error, setError] = useState('')
  // A send that did not go: why, in words (the message is back in the box).
  const [notSent, setNotSent] = useState<string | null>(null)
  const [held, setHeld] = useState<{ pid: number; text: string; images: Attachment[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const row = useRef<HTMLDivElement>(null)
  useTightRow(row)
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
  // A new session's agent goes with its model: the model menu lists both.
  // A session with history keeps its agent; its menu offers no other.
  const pickProvider = (p: string, c: Choice) => {
    setProvider(p)
    rememberProvider(p)
    setChoice(c)
    // Codex has no separate "Edit automatically".
    if (p === 'codex') setMode((m) => (realMode(m) === 'acceptEdits' ? 'manual' : m))
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
    el.style.height = Math.min(el.scrollHeight, (window.visualViewport?.height ?? window.innerHeight) / 3) + 'px'
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

  // again: a message that is not the box's (sent anyway, or a turn tried
  // again); keep: leave the box as it is (a retry from the transcript).
  const send = async (force = false, again?: { text: string; images: Attachment[] }, keep = false) => {
    const t = again ? again.text : text.trim()
    const imgs = again ? again.images : images
    if ((!t && !imgs.length) || busy) return
    // Its path is not in the box yet, and the agent would not find the file.
    if (uploading.length) {
      setError('Wait for the upload to finish.')
      return
    }
    // A built-in that only works in the terminal is answered, not sent:
    // sent, the turn hangs. The text stays in the box.
    const blocked = !again && !codex ? slashBlock(t, slash.has) : ''
    if (blocked) {
      setError(blocked)
      return
    }
    // While a turn runs the message waits on the server and goes when the
    // turn ends (queue.go), shown above the box meanwhile, not as sent.
    const queue = !!(id && turn)
    if (queue) holdQueue()
    setError('')
    setNotSent(null)
    setHeld(null)
    setBusy(true)
    const promptId = newPromptId()
    if (!queue) addPending({ id: promptId, session: id, text: t, images: imgs.map((i) => i.url), at: Date.now() })
    // The box empties at once; a failure puts everything back.
    if (!keep) {
      setText('')
      setImages([])
    }
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
        if (choice.model) startedModel.set(r.session, choice.model)
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
    else setNotSent(r.kind === 'auth' ? 'This device is not logged in. Open the login link again.' : r.kind === 'lost' ? 'No answer from the server.' : why(r.message))
    box.current?.focus()
  }

  // The tap is acknowledged at once; the turn's end (a few seconds when
  // the CLI is mid-tool) clears it. On a failure the button comes back.
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!turn) setStopping(false)
  }, [!turn])
  // Just after a message is queued the button stays Queue for a moment,
  // so a second tap on the same spot does not land on Stop.
  const [justQueued, setJustQueued] = useState(false)
  const queuedT = useRef(0)
  const holdQueue = () => {
    setJustQueued(true)
    clearTimeout(queuedT.current)
    queuedT.current = window.setTimeout(() => setJustQueued(false), 900)
  }
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
  // More than a couple fold into one line (a turn that started watchers on
  // a cluster job left ten of them, bash, tail and grep each, and the rows
  // covered the transcript on 2026-11-15); the list opens on request and
  // scrolls, and one button ends them all.
  const [showLeftovers, setShowLeftovers] = useState(false)
  const folded = (leftovers?.length ?? 0) > 2
  const stopAllLeftovers = async () => {
    const r = await Promise.allSettled((leftovers ?? []).map((p) => postJSON(`/api/sessions/${id}/leftovers/${p.pid}/stop`, {})))
    const failed = r.find((x): x is PromiseRejectedResult => x.status === 'rejected')
    if (failed) setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
  }

  const unqueue = async (promptId: string) => {
    try {
      takeBack(await postJSON<TakenBack>(`/api/sessions/${id}/unqueue/${promptId}`, {}))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ session: string; text: string }>).detail
      if (d.session === id) send(false, { text: d.text, images: [] }, true)
    }
    window.addEventListener('dakort:retry', on)
    return () => window.removeEventListener('dakort:retry', on)
  })

  const sendHeld = () => {
    if (!held) return
    // The text went back into the box; send it from there, forced.
    const again = { text: text.trim(), images }
    send(true, again)
  }

  return (
    <div className="composer">
      {/* What stacks above the box: one block, so a short window can cap it
          as a whole (the box and the conversation stay in view). */}
      <div className="composer-stack">
        {held && (
          <div className="notice warnbox">
            This session is open in another Claude process (pid {held.pid}). Sending now makes the two diverge: each
            continues its own branch of the transcript.
            <div className="row-buttons">
              <Button variant="outline" size="sm" onClick={() => setHeld(null)}>
                Cancel
              </Button>
              <Button variant="default" size="sm" onClick={sendHeld}>
                Send anyway
              </Button>
            </div>
          </div>
        )}
        {missing && (
          <div className="notice error missing-cli" role="alert">
            <div className="notice-row">
              <ErrorMark />
              <div className="notice-text">
                <div className="notice-title">{who === 'Claude' ? 'Claude Code' : who} is not installed on this machine</div>
                <div className="notice-why">
                  In {missing.shell}, run <code>{missing.install}</code>, then run <code>{missing.signIn}</code> once to sign in, and reload this page.
                </div>
              </div>
            </div>
          </div>
        )}
        {notSent !== null && (
          <div className="notice error not-sent" role="alert">
            <div className="notice-row">
              <ErrorMark />
              <div className="notice-text">
                <div className="notice-title">Not sent. Your message is back in the box.</div>
                <div className="notice-why">{notSent}</div>
              </div>
              <button type="button" className="notice-x" aria-label="Dismiss" title="Dismiss" onClick={() => setNotSent(null)}>
                <XIcon />
              </button>
            </div>
            <div className="notice-actions">
              <Button type="button" variant="outline" size="sm" onClick={() => send()}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {error && (
          <div className="notice error" role="alert">
            <div className="notice-row">
              <ErrorMark />
              <div className="notice-text">{error}</div>
              <button type="button" className="notice-x" aria-label="Dismiss" title="Dismiss" onClick={() => setError('')}>
                <XIcon />
              </button>
            </div>
          </div>
        )}
        {id && <Tasks session={id} who={who} model={choice.model} onError={setError} />}
        {leftovers?.length ? (
          <div className="queued leftovers">
            {folded && (
              <div className="queued-item leftovers-head">
                <span className="leftovers-count" title="Left by earlier turns" data-tip-tap="">
                  <WarnIcon />
                  <span className="ellipsis">{leftovers.length} processes still running</span>
                </span>
                <Button variant="outline" size="xs" onClick={() => setShowLeftovers(!showLeftovers)} aria-expanded={showLeftovers}>
                  {showLeftovers ? 'Hide' : 'Show'}
                </Button>
                <Button variant="outline" size="xs" className="stop-all" onClick={stopAllLeftovers} title="End every one of them">
                  Stop all
                </Button>
              </div>
            )}
            {(!folded || showLeftovers) && (
              <div className="leftovers-list">
                {leftovers.map((p) => (
                  <div key={p.pid} className="queued-item leftover-item" title={[p.name, p.command, p.dir].filter(Boolean).join('\n')}>
                    <span className="leftover-what">
                      <span className="leftover-cmd">
                        <b>{p.name}</b>
                        {p.command ? <code>{p.command}</code> : null}
                      </span>
                      <span className="leftover-meta">
                        Still running{p.started ? ` · ${ago(p.started)}` : ''}
                        {p.dir ? (
                          <>
                            {' · in '}
                            <span className="leftover-dir">{p.dir}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    <Button variant="outline" size="xs" onClick={() => stopLeftover(p.pid)} title="End this process">
                      Stop
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {queued?.length ? (
          <div className="queued">
            {queued.map((q) => (
              <QueuedItem key={q.promptId} q={q} onTakeBack={() => unqueue(q.promptId)} />
            ))}
          </div>
        ) : null}
        {uploading.length > 0 && <div className="notice faint small uploading">Uploading {uploading.join(', ')} to the project folder…</div>}
      </div>
      {/* Images going with the message: under the stack, never scrolled away in it. */}
      {images.length > 0 && (
        <div className="attachments">
          {images.map((im, i) => (
            <span key={im.url} className="attachment">
              <img src={im.url} alt="" />
              <button className="tab-x" aria-label="Remove image" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                <XIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        className={cn(
          'composer-box rounded-xl border border-input bg-background shadow-xs transition-[color,box-shadow] has-[>textarea:focus]:border-ring/40 dark:bg-input/30',
          session?.heldBy && 'held',
        )}
        // A tap anywhere on the card that is not a control goes to the box:
        // the text field is one line tall, the card is the target.
        onClick={(e) => {
          const t = e.target as HTMLElement
          if (t === e.currentTarget || t.classList.contains('composer-row') || t.classList.contains('grow')) box.current?.focus()
        }}
      >
        <SlashMenu menu={slash} pick={pickCommand} />
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder={id ? `Message ${who}` : 'Start a new session in this project'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && slash.onKey(e, pickCommand)) return
            // Escape stops the turn, as in Claude Code: with a draft in the
            // box the button at the row's end is Send, not Stop.
            if (e.key === 'Escape' && turn && !stopping && !e.nativeEvent.isComposing && !e.defaultPrevented) {
              e.preventDefault()
              stop()
              return
            }
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
        <div className="composer-row" ref={row}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="cbtn attach text-muted-foreground hover:text-foreground"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => file.current?.click()}
          >
            <PlusIcon />
          </Button>
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
          {/* The agent and its model, effort and switches in one menu. */}
          <ModelPicker
            value={choice}
            onChange={pickChoice}
            onSwitch={id ? undefined : pickProvider}
            provider={provider}
            idleCompact={
              id && !codex
                ? {
                    on: session?.idleCompact !== false,
                    toggle: () => postJSON(`/api/sessions/${id}/settings`, { idleCompact: session?.idleCompact === false }).then(refreshLists, () => {}),
                  }
                : undefined
            }
          />
          {/* The chip shows the current mode's name and is as wide as it; its
              menu names each mode with what it does (a native select's
              options could not say that, and an OS picker dropped it). */}
          <PopMenu
            className="mode-menu"
            chipClass={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'chip mode-chip h-7 flex-none gap-1 px-2 font-normal pointer-coarse:h-11')}
            sheetTitle="Permission mode"
            label={'Permission mode: ' + (allModes.find(([v]) => v === shownMode)?.[1] ?? shownMode)}
            title={allModes.find(([v]) => v === shownMode)?.[2]}
            chip={
              <>
                {shownMode === 'bypassPermissions' && <WarnIcon />}
                <span className="mode-long">{allModes.find(([v]) => v === shownMode)?.[1] ?? shownMode}</span>
                <span className="mode-short" aria-hidden="true">
                  {shortMode[shownMode] ?? shownMode}
                </span>
                <Chevron />
              </>
            }
          >
            {(close) => (
              <div role="listbox" aria-label="Permission mode">
                {(shownMode === 'dontAsk' ? allModes : modeList).map(([v, l, d]) => (
                  <MenuOption
                    key={v}
                    on={v === shownMode}
                    label={
                      v === 'bypassPermissions' ? (
                        <>
                          {l}
                          <span className="mode-warn">
                            <WarnIcon />
                          </span>
                        </>
                      ) : (
                        l
                      )
                    }
                    desc={d}
                    onPick={() => {
                      setMode(v)
                      close()
                    }}
                  />
                ))}
              </div>
            )}
          </PopMenu>
          <span className="grow" />
          {/* The end of the row as one group: when a tight row takes a
              second line, these move together to its end. */}
          <span className="composer-end" data-align-ok="separate controls centred on the row: the meter's figures are a size smaller than the chips' labels">
          {session?.heldBy ? (
            <span
              className="held-note"
              data-tip="Sending here forks it"
              data-tip-tap=""
              tabIndex={0}
              role="note"
              aria-label="In another Claude"
            >
              <WarnIcon />
              <span className="held-text">In another Claude</span>
            </span>
          ) : null}
          {id && (context || (!turn && !codex)) ? <Meter session={id} context={context} model={used?.model} cache={!turn && !codex} /> : null}
          {/* One button at the row's end, as Claude desktop has it: Send;
              during a turn Stop, which turns into Send (queued for the
              turn's end) as soon as there is something to send. */}
          {turn && !justQueued && !text.trim() && !images.length ? (
            <Button
              size="icon-sm"
              className={cn('send stop bg-foreground text-background hover:bg-foreground/90 disabled:opacity-100', stopping && 'stopping')}
              onClick={stop}
              disabled={stopping}
              aria-label={stopping ? 'Stopping' : 'Stop'}
              title="Stop"
            >
              <StopIcon />
            </Button>
          ) : (
            <Button
              size="icon-sm"
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
              title={turn ? 'Queue' : 'Send'}
            >
              <ArrowIcon />
            </Button>
          )}
          </span>
        </div>
      </div>
    </div>
  )
}

// notSent says a message did not go, why, and where it is now.
// why is a refused send's reason in words: a bare status says it is the
// server's answer.
const why = (msg: string) => {
  const code = /^HTTP (\d+)$/.exec(msg)?.[1]
  return code ? `The server answered ${code}.` : msg
}

// retryPrompt sends a prompt again from the session's composer (Try again
// under a failed turn), with the chips as they are and the box left alone.
export const retryPrompt = (session: string, text: string) => window.dispatchEvent(new CustomEvent('dakort:retry', { detail: { session, text } }))

// QueuedItem is a message waiting for the turn to end. Its text shows two
// lines; a tap shows all of it. Its button takes it back into the box to
// edit (a pencil, not a cross: nothing is thrown away, and not an arrow
// that reads as Send).
function QueuedItem({ q, onTakeBack }: { q: { text: string; images?: number; error?: string }; onTakeBack: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'queued-item' + (open ? ' open' : '')}>
      <button type="button" className="queued-text" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="queued-label" title={q.error ? undefined : 'Goes when the turn ends'}>
          {q.error ? (
            <>
              <Cross />
              Not sent
            </>
          ) : (
            'Queued'
          )}
        </span>
        <span className="queued-body">
          <span className="queued-words">
            {q.text}
            {q.images ? ` (+${q.images} image${q.images > 1 ? 's' : ''})` : ''}
          </span>
          {q.error && <span className="queued-why">It goes again after the next turn ({q.error}).</span>}
        </span>
      </button>
      <button className="task-x" aria-label="Edit" title="Edit" onClick={onTakeBack}>
        <BackIcon />
      </button>
    </div>
  )
}

// Tasks lists the session's background tasks (a command run in the
// background, an agent, a monitor), each with a stop. Claude is woken when
// one ends or a monitor prints; a stopped one ends quietly. The chip's
// mark says what kind it is (still: the working line is the one moving
// mark), and hovering or tapping its name opens a card with the rest.
function Tasks({ session, who, model, onError }: { session: string; who: string; model: string; onError: (msg: string) => void }) {
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
        <span key={k.id} className="task">
          <TaskChip task={k} who={who} model={model} />
          <button className="task-x" aria-label="Stop this task" title="Stop" disabled={stopping.includes(k.id)} onClick={() => stop(k.id)}>
            <XIcon />
          </button>
        </span>
      ))}
    </div>
  )
}

// What kind of task the CLI's type names: local_bash, local_agent,
// remote_agent, monitor (the CLI's source names these).
const taskKind = (k: Task): 'agent' | 'command' | 'monitor' | 'task' =>
  /agent/.test(k.type) ? 'agent' : /bash|shell|command/.test(k.type) ? 'command' : /monitor/.test(k.type) ? 'monitor' : 'task'

// A span of time as the card says it: 45s, 4m 12s, 1h 3m.
function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// TaskChip is a task's name in the composer, with a hover card (a tap
// on touch) saying what it is: its kind, what it does, an agent's type
// and model, a command's line, when it began and how long it has run,
// and how far it is (its steps and latest step, when the CLI says).
function TaskChip({ task: k, who, model }: { task: Task; who: string; model: string }) {
  const [open, setOpen] = useState(false)
  const kind = taskKind(k)
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={250} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button type="button" className="task-label" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={kind === 'agent' ? 'bot' : kind === 'monitor' ? 'eye' : 'square-terminal'} sm className="task-kind" />
          <span className="ellipsis">{k.description || k.type}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" sideOffset={6} className="task-card w-auto max-w-80 min-w-60 p-3 text-sm">
        <TaskCard task={k} kind={kind} who={who} model={model} />
      </HoverCardContent>
    </HoverCard>
  )
}

function TaskCard({ task: k, kind, who, model }: { task: Task; kind: ReturnType<typeof taskKind>; who: string; model: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const started = k.started ? Date.parse(k.started) : 0
  const title = kind === 'task' ? 'Background task' : `Background ${kind}`
  // The model an agent runs on: the one its call asked for, else the
  // session's for a general agent (an agent type of its own may set
  // another, which the CLI does not say, so nothing is claimed then).
  const runsOn = kind !== 'agent' ? '' : k.model ? modelLabel(aliasOf(k.model)) : !k.subagent || k.subagent === 'general-purpose' ? `${modelLabel(model || 'default')} (the session’s)` : ''
  const rows: [string, React.ReactNode][] = []
  if (kind === 'agent' && k.subagent) rows.push(['Type', k.subagent])
  if (runsOn) rows.push(['Model', runsOn])
  if (started)
    rows.push([
      'Started',
      <>
        {new Date(started).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        <span className="task-card-faint"> · running {span(now - started)}</span>
      </>,
    ])
  if (k.steps) rows.push(['Progress', `${k.steps} step${k.steps === 1 ? '' : 's'}`])
  if (k.last) rows.push(['Now', <span className="task-card-last">{k.last}</span>])
  return (
    <div className="task-card-body">
      <div className="task-card-title">
        <span className="task-card-kind">{title}</span>
      </div>
      <div className="task-card-desc">{k.description || k.type}</div>
      {k.command && <code className="task-card-cmd">{k.command}</code>}
      {rows.length > 0 && (
        <dl className="task-card-rows">
          {rows.map(([dt, dd]) => (
            <div key={dt}>
              <dt>{dt}</dt>
              <dd>{dd}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="task-card-foot">{who} is told when it ends.</div>
    </div>
  )
}

// Meter is the session's state in one control: the last call's context as
// a pie against the model's window (see contextwindow.ts; amber past 75%,
// red past 90%), and the prompt cache counting down from Claude's last
// reply (past it, the next message pays to read the whole context in
// again). A laptop says the tokens and the minutes beside the pie; a phone
// the share of the window, or Cold once the cache is gone. A tap, a
// hover or the keyboard's focus says the rest (tips.ts). The session's
// idle-compaction switch is in the model menu, with its other settings.
function Meter({ session, context, model, cache }: { session: string; context?: number; model?: string; cache: boolean }) {
  const cfg = useConfig()
  const replyModel = useStore((s) => s.replyModel[session])
  const stated = useStore((s) => s.rowWindow[session]) ?? 0
  const last = useStore((s) => s.lastReply[session])
  const life = useStore((s) => s.cacheLife[session])
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  const win = context ? windowFor(replyModel || model, stated) : undefined
  const pct = win && context ? Math.min(100, (context / win.tokens) * 100) : 0
  const level = pct >= 90 ? ' high' : pct >= 75 ? ' mid' : ''
  // The tip in one short line; the screen reader's name says it in full.
  const lines: string[] = []
  const short: string[] = []
  if (context) {
    lines.push(
      win
        ? `Context: ${tokens(context)} of ${tokens(win.tokens)} tokens (${Math.round(pct)}%) in the last call${win.assumed ? ', window assumed' : ''}.`
        : `Context: ${tokens(context)} tokens in the last call.`,
    )
    short.push(win ? `${tokens(context)} of ${tokens(win.tokens)} tokens` : `${tokens(context)} tokens`)
  }
  let clock = ''
  let expired = false
  if (cache && last) {
    const left = last + cacheLifeMs(cfg, life) - now
    expired = left <= 0
    const mins = Math.ceil(left / 60_000)
    clock = expired ? 'Cold' : mins > 1 ? `${mins}m` : '<1m'
    lines.push(
      expired
        ? `The prompt cache has likely expired; the next message reads ${context ? `about ${tokens(context)} tokens` : 'the whole context'} in again.`
        : `The prompt cache stays warm for ${clock} more; a message before then reuses it.`,
    )
    short.push(expired ? 'cache cold' : `cache warm ${clock}`)
  }
  if (!lines.length) return null
  const tip = short.join(' · ')
  // A pie against the window (not a ring: a turning ring means working):
  // r 6.5 on an 18 px box, the wedge the share of the window used.
  // At least a visible slice: a hairline wedge read as a clock's hand.
  const a = (Math.min(Math.max(pct, 8), 99.9) / 100) * 2 * Math.PI
  const wedge = `M9 9V2.5A6.5 6.5 0 ${a > Math.PI ? 1 : 0} 1 ${(9 + 6.5 * Math.sin(a)).toFixed(2)} ${(9 - 6.5 * Math.cos(a)).toFixed(2)}Z`
  return (
    <button type="button" className={'meter' + level + (expired ? ' expired' : '') + (clock ? ' cache-clock' : '')} data-tip={tip} data-tip-tap="" aria-label={lines.join(' ')}>
      {context ? (
        <span className="ctx">
          <svg className="ctx-pie" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <circle cx="9" cy="9" r="7.5" className="ctx-track" />
            {win && pct > 0 && <path d={wedge} className="ctx-fill" />}
          </svg>
          <span className="ctx-num">{tokens(context)}</span>
          {win && !expired && <span className="ctx-pct">{Math.round(pct)}%</span>}
        </span>
      ) : null}
      {clock ? (
        <span className="cache-text">
          <ClockIcon />
          {clock}
        </span>
      ) : null}
    </button>
  )
}

// useTightRow makes room for the model chip's whole name, a step at a
// time: the mode chip drops its caret, in Bypass it keeps only its warning
// sign, during a turn on a phone the meter steps aside, and last the row
// takes a second line (the meter back, Bypass named again if it fits, the
// end group at the line's end) rather than cut the name. While idle, or at
// a large text size, the row wraps instead of hiding the meter: the meter
// says what the session holds, and a wider screen must not show less.
// Every pass starts loose and tightens until the name fits, measuring
// before the frame is painted, so the row cannot flip back and forth (it
// did at 200% text, where the meter is wider than any guess). Run on every
// render and whenever the row, its parts or their text change. A chip is
// cut when its text is wider than its box inside the padding (WebKit's
// scrollWidth leaves out text running into the padding).
const isCut = (el: HTMLElement) => {
  const range = document.createRange()
  range.selectNodeContents(el)
  const cs = getComputedStyle(el)
  // Fractional widths: clientWidth is rounded, and a cut of a quarter pixel
  // still draws the ellipsis.
  const inner =
    el.getBoundingClientRect().width -
    parseFloat(cs.borderLeftWidth) -
    parseFloat(cs.borderRightWidth) -
    parseFloat(cs.paddingLeft) -
    parseFloat(cs.paddingRight)
  return range.getBoundingClientRect().width > inner + 0.01 || el.scrollWidth > el.clientWidth + 1
}
// lines counts the row's lines by where its shown parts sit.
const lines = (r: HTMLElement) => {
  const mids = Array.from(r.querySelectorAll<HTMLElement>(':scope > :not(input, .grow)'))
    .filter((el) => el.offsetParent !== null)
    .map((el) => {
      const b = el.getBoundingClientRect()
      return (b.top + b.bottom) / 2
    })
    .sort((a, b) => a - b)
  return mids.filter((m, i) => i === 0 || m - mids[i - 1] > 8).length
}
function useTightRow(row: MutableRefObject<HTMLDivElement | null>) {
  const check = () => {
    const r = row.current
    const chip = r?.querySelector<HTMLElement>(':scope > .model-menu > .chip-btn')
    if (!r || !chip) return
    delete r.dataset.tight
    delete r.dataset.nometer
    // 1: the mode's caret; 2: Bypass's name (its sign stays).
    let level = 0
    while (level < 2 && isCut(chip)) r.dataset.tight = String(++level)
    // 3: during a turn at the usual text size, the meter steps aside
    // (Stop and Queue take its room), unless it says Cold, the state to
    // act on. With it gone, Bypass gets its name back if that fits.
    const cold = !!r.querySelector(':scope > .composer-end > .meter.expired')
    const big = parseFloat(getComputedStyle(document.documentElement).fontSize) > 16
    const turn = !!r.querySelector(':scope > .composer-end > .send.stop')
    if (isCut(chip) && !cold && !big && turn) {
      r.dataset.nometer = ''
      if (level === 2) {
        r.dataset.tight = '1'
        if (isCut(chip)) r.dataset.tight = '2'
      }
    }
    // 4: a second line, with the meter back, Bypass named and the end group
    // at its end; 5: Bypass's sign alone, if its name made a third line.
    if (isCut(chip)) {
      r.dataset.tight = '4'
      delete r.dataset.nometer
      const mode = r.querySelector<HTMLElement>(':scope > .mode-menu .mode-chip')
      if (lines(r) > 2 || (mode && isCut(mode))) r.dataset.tight = '5'
    }
  }
  // After a render, only when the row itself changed (its markup or its
  // width): typing re-renders the composer on every key, and the check's
  // writes and reads forced a layout each time.
  const seen = useRef('')
  useLayoutEffect(() => {
    const r = row.current
    if (!r) return
    const key = r.clientWidth + '|' + r.innerHTML
    if (key === seen.current) return
    seen.current = key
    check()
  })
  // The row's parts change size on their own too (the meter's "4%"
  // becoming "Cold", a chip's name): watch each of them and the row's own
  // children, not the menus opened from it.
  useEffect(() => {
    const r = row.current
    if (!r || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const soon = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(check)
    }
    const ro = new ResizeObserver(soon)
    const watch = () => {
      ro.disconnect()
      ro.observe(r)
      for (const el of r.querySelectorAll<HTMLElement>(':scope > *, :scope > .model-menu > .chip-btn')) ro.observe(el)
    }
    watch()
    const mo = new MutationObserver((list) => {
      if (list.some((m) => m.target === r || (m.target as Node).parentNode === r || r.querySelector(':scope > .model-menu > .chip-btn')?.contains(m.target))) {
        watch()
        soon()
      }
    })
    mo.observe(r, { childList: true, subtree: true, characterData: true })
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])
}

const PlusIcon = () => <Icon name="plus" />
const ArrowIcon = () => <Icon name="arrow-up" />
const StopIcon = () => <Icon name="square" sm fill />
const Chevron = () => <Icon name="chevron-down" sm className="caret" />
const WarnIcon = () => <Icon name="triangle-alert" sm />
// Back to the box: an arrow returning down-left.
const BackIcon = () => <Icon name="pencil" />
const XIcon = () => <Icon name="x" sm />
const ClockIcon = () => <Icon name="clock" sm />
