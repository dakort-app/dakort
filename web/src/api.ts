import type { Folder, Move, Page, Session } from './types'

// AuthError is a 401: the cookie is missing or the token changed.
export class AuthError extends Error {
  constructor() {
    super('not logged in')
  }
}

export class HTTPError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, body: Record<string, unknown>, text: string) {
    super(typeof body.error === 'string' ? body.error : text || `HTTP ${status}`)
    this.status = status
    this.body = body
  }
}

async function check(r: Response): Promise<Response> {
  if (r.status === 401) throw new AuthError()
  if (!r.ok) {
    const text = await r.text()
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(text)
    } catch {
      // a plain-text error
    }
    throw new HTTPError(r.status, body, text.trim())
  }
  return r
}

export async function getJSON<T>(url: string): Promise<T> {
  return (await check(await fetch(url, { cache: 'no-store' }))).json()
}

// postJSON sends a JSON body; the server refuses any other content type.
export async function postJSON<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  return (await check(r)).json()
}

export const api = {
  sessions: () => getJSON<Session[]>('/api/sessions'),
  folders: () => getJSON<Folder[]>('/api/folders'),
  openFolder: (path: string) => postJSON<{ path: string }>('/api/folders/open', { path }),
  closeFolder: (path: string) => postJSON('/api/folders/close', { path }),
  renameFolder: (path: string, name: string) => postJSON<{ path: string }>('/api/folders/rename', { path, name }),
  moves: () => getJSON<Move[]>('/api/folders/moves'),
  // The folder's open tabs, shared by every device; ids null until some
  // device has set them.
  tabs: (folder: string) => getJSON<{ ids: string[] | null }>('/api/tabs?folder=' + encodeURIComponent(folder)),
  setTabs: (folder: string, ids: string[]) => postJSON('/api/tabs', { folder, ids }),
  mkdir: (path: string, name: string) => postJSON<{ path: string }>('/api/browse/mkdir', { path, name }),
  tail: (id: string, before?: number, n?: number) => {
    const q = new URLSearchParams()
    if (before !== undefined) q.set('before', String(before))
    if (n !== undefined) q.set('n', String(n))
    return getJSON<Page>(`/api/sessions/${id}/rows?${q}`)
  },
  after: (id: string, off: number) => getJSON<Page>(`/api/sessions/${id}/rows?after=${off}`),
  // A CLI's sign-in run by the server (SignIn.tsx): start it, follow it,
  // hand Claude the pasted code.
  signIn: (cli: string) => postJSON<SignInState>('/api/signin', { cli }),
  signInState: (cli: string) => getJSON<SignInState>('/api/signin?cli=' + cli),
  signInCode: (cli: string, code: string) => postJSON<SignInState>('/api/signin/code', { cli, code }),
}

export type SignInState = {
  cli: string
  state: 'starting' | 'waiting' | 'done' | 'failed'
  url?: string
  code?: string // Codex: the one-time code to type on its page
  pasteCode?: boolean // Claude: its page hands back a code to paste
  error?: string
}

export const assetURL = (name: string) => `/api/assets/${name}`
