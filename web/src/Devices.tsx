import { useEffect, useState } from 'react'
import { api, HTTPError } from './api'
import type { DevicesState } from './api'

// The Other devices panel, behind the icon beside the moon: where a phone
// or another computer reaches this one, and the password it logs in with.
// The first opening asks for the password; after that, the address and a
// QR code, with a link to change the password (from any logged-in
// device: being in is the proof). Tailscale off or missing is said here,
// where the person is looking, not in a log. Nobody has to go back to
// the terminal for any of it.
export function Devices({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<DevicesState | null>(null)
  const [err, setErr] = useState('')
  const [changing, setChanging] = useState(false)
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () =>
    api
      .devices()
      .then(setSt)
      .catch((e) => setErr(e instanceof HTTPError ? e.message : String(e)))
  useEffect(() => {
    load()
  }, [])

  const save = async () => {
    if (p1 !== p2) {
      setErr('The two passwords differ.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await api.setPassword(p1)
      setP1('')
      setP2('')
      setChanging(false)
      await load()
    } catch (e) {
      setErr(e instanceof HTTPError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const choosing = st && (!st.passwordSet || changing)
  let body = <p className="faint">…</p>
  if (st && choosing) {
    body = (
      <form
        className="devices-form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <p>{st.passwordSet ? 'A new password for your other devices.' : 'Choose a password for your other devices.'}</p>
        <p className="faint small">
          At least 8 characters. Each device logs in with it once and stays logged in.
          {st.passwordSet ? ' Devices already logged in stay logged in.' : ''}
        </p>
        <input className="devices-input" type="password" autoComplete="new-password" placeholder="Password" value={p1} onChange={(e) => setP1(e.target.value)} autoFocus aria-label="Password" />
        <input className="devices-input" type="password" autoComplete="new-password" placeholder="The same again" value={p2} onChange={(e) => setP2(e.target.value)} aria-label="The same again" />
        <div className="row-buttons">
          {st.passwordSet && (
            <button className="btn" type="button" onClick={() => setChanging(false)}>
              Cancel
            </button>
          )}
          <button className="btn primary" type="submit" disabled={busy || p1.length < 8}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    )
  } else if (st) {
    // One address on the tailnet (https when Tailscale Serve gives one; the
    // plain one is the same page and only confused), plus any -expose ones.
    const main = st.addrs.find((a) => a.kind !== 'exposed')
    const exposed = st.addrs.filter((a) => a.kind === 'exposed')
    body = (
      <>
        {st.tailscale === 'none' && (
          <p>
            Tailscale is not installed on this computer. For a phone or another computer, install it on both from{' '}
            <a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">
              tailscale.com/download
            </a>{' '}
            and sign both in with the same account.
          </p>
        )}
        {st.tailscale === 'down' && <p>Tailscale is installed but not running on this computer{st.why ? ` (${st.why})` : ''}. Turn it on, then open this again.</p>}
        {main && (
          <>
            <p>On your phone or another computer, with Tailscale on and the same account, open</p>
            <a className="devices-addr" href={main.url} target="_blank" rel="noopener noreferrer">
              {main.url}
            </a>
            <p>or scan this with the phone's camera.</p>
            <img className="devices-qr" src={'/api/devices/qr?url=' + encodeURIComponent(main.url)} alt={'QR code of ' + main.url} />
          </>
        )}
        {exposed.length > 0 && (
          <>
            <p>On this network, without Tailscale, open</p>
            {exposed.map((a) => (
              <a key={a.url} className="devices-addr" href={a.url} target="_blank" rel="noopener noreferrer">
                {a.url}
              </a>
            ))}
            <p className="warn small">Anyone on that network gets the login page. The password is all that guards this computer.</p>
          </>
        )}
        <p className="faint small">
          <button className="linkish" onClick={() => setChanging(true)}>
            Change password
          </button>
        </p>
      </>
    )
  }
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="bar">
          <b>Other devices</b>
          <span className="grow" />
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="devices">
          {body}
          {err && <p className="error">{err}</p>}
        </div>
      </div>
    </div>
  )
}
