import { useEffect, useRef, useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

// ask is the app's confirm(): shadcn's AlertDialog in the page's own look,
// where the browser's box said "localhost says" over everything. It
// resolves true on the action, false on Cancel, Escape or a click outside.
// The action has the focus, so Enter confirms; a destructive one is red.

export type Ask = { title: string; text?: string; action: string; cancel?: string; destructive?: boolean }

type Open = Ask & { done: (ok: boolean) => void }
let show: ((a: Open) => void) | null = null

export function ask(a: Ask): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(window.confirm(a.title)) // no host mounted (never in the app)
    show({ ...a, done: resolve })
  })
}

// AskHost renders the open question; main.tsx mounts one beside the app.
export function AskHost() {
  const [q, setQ] = useState<Open | null>(null)
  const action = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    show = setQ
    return () => {
      show = null
    }
  }, [])
  const close = (ok: boolean) => {
    q?.done(ok)
    setQ(null)
  }
  return (
    <AlertDialog open={!!q} onOpenChange={(o) => !o && close(false)}>
      {q && (
        <AlertDialogContent
          size="sm"
          className="ask"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            action.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">{q.title}</AlertDialogTitle>
            {q.text && <AlertDialogDescription>{q.text}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" onClick={() => close(false)}>
              {q.cancel ?? 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction ref={action} size="sm" variant={q.destructive ? 'destructive' : 'default'} onClick={() => close(true)}>
              {q.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  )
}
