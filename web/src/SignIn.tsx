import { useEffect, useRef, useState } from 'react'
import { api, HTTPError } from './api'
import { Icon } from './icons'
import type { SignInState } from './api'
import { CopyButton } from './Devices'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

// The notice under a turn that failed because the CLI is not signed in,
// with the sign-in itself: the server runs the CLI's own login command
// and the page shows its link. Claude's link ends on a page with a code
// to paste back here; Codex's shows a one-time code to type on its page
// and finishes by itself. Both work from a phone. The terminal way stays
// as the fallback line.
// why is the server's reason with a full stop (its first word kept as it
// is: it is often a command, "claude: executable file not found").
const why = (m: string) => (/no sign-in going/i.test(m) ? 'There was no sign-in in progress.' : m.replace(/\.?$/, '.'))

export function SignIn({ cli }: { cli: 'claude' | 'codex' }) {
  const who = cli === 'codex' ? 'Codex' : 'Claude'
  const [st, setSt] = useState<SignInState | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Which step failed: starting, or the pasted code (which can fail after
  // the sign-in itself has ended, and then shows on the start card).
  const [errKind, setErrKind] = useState<'start' | 'code'>('start')
  const [code, setCode] = useState('')
  const input = useRef<HTMLInputElement>(null)
  // The card had the focus: when the part holding it is replaced (a start
  // that failed, a sign-in that timed out under the code field), the focus
  // goes to the card's main button rather than to the page.
  const card = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  useEffect(() => {
    if (!hadFocus.current) return
    const a = document.activeElement
    if (a && a !== document.body && a.isConnected) return
    card.current?.querySelector<HTMLElement>('.btn.primary, .signin-open')?.focus({ preventScroll: true })
  })
  const track = {
    ref: card,
    onFocus: () => (hadFocus.current = true),
    onBlur: (e: React.FocusEvent) => (hadFocus.current = !!e.relatedTarget && !!card.current?.contains(e.relatedTarget as Node)),
  }

  const start = async () => {
    // Pressed from the keyboard, the focus goes on to the next step (this
    // button is replaced by the steps).
    const keys = !!document.activeElement?.closest('.signin')
    setBusy(true)
    setErr('')
    try {
      setSt(await api.signIn(cli))
      if (keys) requestAnimationFrame(() => document.querySelector<HTMLElement>('.signin .signin-open')?.focus({ preventScroll: true }))
    } catch (e) {
      setErrKind('start')
      setErr(e instanceof HTTPError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const paste = async () => {
    if (!code.trim()) {
      input.current?.focus()
      return
    }
    setBusy(true)
    setErr('')
    try {
      setSt(await api.signInCode(cli, code))
    } catch (e) {
      setErrKind('code')
      setErr(e instanceof HTTPError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // While waiting, ask for the state now and then: Codex finishes on its
  // own once the code is typed, and Claude once the code is pasted.
  const waiting = st?.state === 'waiting'
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => api.signInState(cli).then(setSt).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [waiting, cli])

  if (st?.state === 'done') {
    return <div className="notice signin" {...track}>Signed in. Send your message again.</div>
  }
  // A neutral card: only the headline's triangle carries the warning.
  const head = (
    <div className="signin-head">
      <Icon name="triangle-alert" sm />
      {who} isn’t signed in on this computer
    </div>
  )
  if (!st || st.state === 'failed') {
    return (
      <div className="notice signin" {...track}>
        {head}
        {err ? (
          // A sign-in that could not start, or a code pasted after it
          // ended: the app's words, then the server's reason.
          <div className="form-err" role="alert">
            {errKind === 'code' ? 'The code did not go through: the sign-in had ended. Start it again.' : 'Could not start the sign-in.'}
            <div className="form-err-why">{why(err)}</div>
          </div>
        ) : st?.error ? (
          <div className="form-err" role="alert">
            The sign-in failed: {st.error.replace(/\.?$/, '.')}
          </div>
        ) : (
          <div className="signin-body">
            Sign in gives you a link to {who}’s sign-in page, {cli === 'codex' ? 'and a code to type there' : 'then you paste the code it shows here'}.
          </div>
        )}
        <div className="signin-actions">
          {/* After a code that failed here, the focus comes to the way on
              (the field it was in is gone). */}
          <Button variant="default" size="sm" onClick={() => !busy && start()} aria-disabled={busy || undefined} autoFocus={!!err && errKind === 'code'}>
            {busy ? 'Starting…' : st || err ? 'Try again' : 'Sign in'}
          </Button>
        </div>
        <div className="signin-alt">
          Or, in a terminal on the computer, run <code>{cli}</code> once and sign in there.
        </div>
      </div>
    )
  }
  return (
    <div className="notice signin" {...track}>
      {head}
      <ol className="signin-steps">
        <li>
          <a className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'signin-open')} href={st.url} target="_blank" rel="noopener noreferrer">
            Open the {who} sign-in page
            <Icon name="external-link" sm />
          </a>
          {cli === 'codex' && st.code ? (
            <>
              <div>It asks for this code:</div>
              <div className="signin-code-row">
                <code className="signin-code">{st.code}</code>
                <CopyButton text={st.code} what="the code" />
              </div>
            </>
          ) : null}
        </li>
        {cli === 'claude' ? (
          <li>
            <div>Paste the code it shows you.</div>
            <div className="signin-actions">
              <Input
                ref={input}
                className="signin-input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && paste()}
                placeholder="Paste the code"
                aria-label="The code from the sign-in page"
                autoComplete="off"
                spellCheck={false}
              />
              <Button variant="default" size="sm" onClick={() => !busy && paste()} aria-disabled={busy || undefined}>
                {busy ? 'Checking…' : 'Done'}
              </Button>
            </div>
          </li>
        ) : (
          <li className="signin-alt">Waiting for the sign-in to finish…</li>
        )}
      </ol>
      {err && (
        // A code that did not go through: the app's words, then the reason.
        <div className="form-err" role="alert">
          The code did not go through.
          <div className="form-err-why">{why(err)}</div>
        </div>
      )}
    </div>
  )
}
