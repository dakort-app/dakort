import { Fragment, useEffect, useState } from 'react'
import { api, HTTPError } from './api'
import type { DevicesState } from './api'
import { CheckIcon, CloseIcon, CopyIcon } from './icons'
import { scrolledEdge } from './a11y'
import { copyText } from './clip'
import { Button } from '@/components/ui/button'
import { sheetBack, sheetPanel } from '@/lib/dialog'
import { Input } from '@/components/ui/input'

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

  const differ = 'The two passwords differ.'
  const save = async () => {
    if (p1 !== p2) {
      setErr(differ)
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
      // In words, as a sentence: the server's own reason, or what went wrong.
      const m = e instanceof HTTPError ? e.message : ''
      setErr(m ? m.charAt(0).toUpperCase() + m.slice(1).replace(/\.?$/, '.') : 'The password could not be saved. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const choosing = st && (!st.passwordSet || changing)
  let body = <p className="faint">Loading…</p>
  if (!st && err) {
    // In the app's words first, then the server's reason, and a way on.
    body = (
      <>
        <div className="form-err" role="alert">
          Could not read this computer’s addresses.
          <div className="form-err-why">{err}</div>
        </div>
        <div>
          <Button
            type="button"
 variant="outline" size="sm"
            onClick={() => {
              setErr('')
              load()
            }}
          >
            Try again
          </Button>
        </div>
      </>
    )
  }
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
        <Input className="devices-input" type="password" autoComplete="new-password" placeholder="Password" value={p1} onChange={(e) => setP1(e.target.value)} autoFocus aria-label="Password" />
        <Input
          className="devices-input"
          type="password"
          autoComplete="new-password"
          placeholder="The same again"
          value={p2}
          onChange={(e) => {
            setP2(e.target.value)
            if (err === differ && e.target.value === p1) setErr('')
          }}
          aria-label="The same again"
          aria-invalid={err === differ}
          aria-describedby={err ? 'devices-err' : undefined}
        />
        {/* Under the field it is about, above the buttons and the keyboard. */}
        {err && (
          <p className="form-err" id="devices-err" role="alert">
            {err}
          </p>
        )}
        <div className="row-buttons">
          {st.passwordSet && (
            <Button
 variant="outline" size="sm"
              type="button"
              onClick={() => {
                // Cancel leaves nothing behind: no error, no typed password.
                setChanging(false)
                setErr('')
                setP1('')
                setP2('')
              }}
            >
              Cancel
            </Button>
          )}
          <Button variant="default" size="sm" type="submit" disabled={busy || p1.length < 8}>
            {busy ? 'Saving…' : 'Set password'}
          </Button>
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
            <Address url={main.url} />
            <p>or scan this code with the other device’s camera.</p>
            <img className="devices-qr" src={'/api/devices/qr?url=' + encodeURIComponent(main.url)} alt={'QR code of ' + main.url} />
          </>
        )}
        {exposed.length > 0 && (
          <>
            <p>On this network, without Tailscale, open</p>
            {exposed.map((a) => (
              <Address key={a.url} url={a.url} />
            ))}
            <p className="warn small">Anyone on that network gets the login page. The password is all that guards this computer.</p>
          </>
        )}
        <div>
          <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
            Change password
          </Button>
        </div>
      </>
    )
  }
  return (
    <div className={sheetBack()} onClick={onClose}>
      <div className={sheetPanel()} role="dialog" aria-label="Other devices" ref={scrolledEdge} onClick={(e) => e.stopPropagation()}>
        <header className="bar">
          <b>Other devices</b>
          <span className="grow" />
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </Button>
        </header>
        <div className="devices">
          {body}
          {err && st && !choosing && <p className="error">{err}</p>}
        </div>
      </div>
    </div>
  )
}

// Address is an address to open on the other device, in a field with a
// Copy button: copying it is what the panel is for, and as a bare link it
// broke mid-word.
function Address({ url }: { url: string }) {
  return (
    <div className="addr-field">
      <a className="devices-addr" href={url} target="_blank" rel="noopener noreferrer">
        {/* Lines break after a dot, a slash or a colon only: never inside a
            word, and never at a hyphen, which a reader would take for the
            line's own and drop when typing it. */}
        {url.split(/(?<=[./:])/).map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <wbr />}
            <span className="nobreak">{part}</span>
          </Fragment>
        ))}
      </a>
      <CopyButton text={url} what="the address" />
    </div>
  )
}

// CopyButton copies text, and shows a check for 2 s once it has.
export function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={() => copyText(text).then(setCopied)} aria-label={copied ? 'Copied' : 'Copy ' + what} title={'Copy ' + what}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}
