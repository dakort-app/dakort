import { memo, useEffect, useState, type MouseEvent } from 'react'
import { copyText } from './clip'
import { loadMath, mathReady, needsMath, render, type RenderOptions } from './mdrender'

// Markdown renders text, with math once KaTeX has loaded (it loads the
// first time some text needs it, then this re-renders).
export const Markdown = memo(function Markdown({ text, opts }: { text: string; opts?: RenderOptions }) {
  const [, setReady] = useState(mathReady())
  const math = needsMath(text)
  useEffect(() => {
    if (math && !mathReady()) loadMath(() => setReady(true))
  }, [math])
  return <div className="md" onClick={copyCode} dangerouslySetInnerHTML={{ __html: render(text, opts) }} />
})

// A code block's Copy button (mdrender) takes the code as it reads, without
// the fence; the button shows a check, or "failed", for a moment.
async function copyCode(e: MouseEvent) {
  const btn = (e.target as Element).closest<HTMLButtonElement>('.code-copy')
  const code = btn?.parentElement?.querySelector('pre')?.textContent
  if (!btn || code == null) return
  const ok = await copyText(code.replace(/\n$/, ''))
  btn.classList.add(ok ? 'copied' : 'failed')
  btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed')
  window.setTimeout(() => {
    btn.classList.remove('copied', 'failed')
    btn.setAttribute('aria-label', 'Copy code')
  }, 1500)
}
