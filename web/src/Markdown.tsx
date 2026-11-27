import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { copyText } from './clip'
import { codeLangs, loadLangs, loadMath, mathReady, needsMath, render, type RenderOptions } from './mdrender'

// Markdown renders text, with math once KaTeX has loaded and code in
// colour once its language's parser has (each loads the first time some
// text needs it, then this re-renders).
export const Markdown = memo(function Markdown({ text, opts }: { text: string; opts?: RenderOptions }) {
  const [, setReady] = useState(mathReady())
  const [, setColoured] = useState(0)
  const math = needsMath(text)
  useEffect(() => {
    if (math && !mathReady()) loadMath(() => setReady(true))
  }, [math])
  const langs = useMemo(() => codeLangs(text).join(), [text])
  useEffect(() => {
    if (langs) loadLangs(langs.split(','), () => setColoured((n) => n + 1))
  }, [langs])
  // A table wider than its column scrolls sideways: it fades at the edge
  // that has more (as the CSV view and the tab row do), so its hidden
  // columns are not taken for missing.
  const box = useRef<HTMLDivElement>(null)
  // Before paint, so a table never shows a frame without its marks.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !el.querySelector('table')) return
    const mark = () => {
      for (const t of el.querySelectorAll<HTMLElement>('table')) {
        // A right-to-left table (dir="auto") scrolls from its right edge
        // (scrollLeft runs from 0 down).
        const rtl = getComputedStyle(t).direction === 'rtl'
        const hidden = t.scrollWidth - t.clientWidth
        const before = rtl ? -t.scrollLeft : t.scrollLeft
        t.toggleAttribute(rtl ? 'data-more-right' : 'data-more-left', before > 1)
        t.toggleAttribute(rtl ? 'data-more-left' : 'data-more-right', before < hidden - 1)
      }
    }
    mark()
    el.addEventListener('scroll', mark, true)
    const ro = new ResizeObserver(mark)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', mark, true)
      ro.disconnect()
    }
  })
  return <div className="md" ref={box} onClick={copyCode} dangerouslySetInnerHTML={{ __html: render(text, opts) }} />
})

// A code block's Copy button (mdrender) takes the code as it reads, without
// the fence; the button shows a check, or "failed", for a moment.
async function copyCode(e: MouseEvent) {
  const btn = (e.target as Element).closest<HTMLButtonElement>('.code-copy')
  const code = btn?.closest('.code-block')?.querySelector('pre')?.textContent
  if (!btn || code == null) return
  const ok = await copyText(code.replace(/\n$/, ''))
  btn.classList.add(ok ? 'copied' : 'failed')
  btn.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed')
  window.setTimeout(() => {
    btn.classList.remove('copied', 'failed')
    btn.setAttribute('aria-label', 'Copy code')
  }, 1500)
}
