import { useLayoutEffect, useRef, useState } from 'react'
import { fold } from './fold'

// A prompt's text, folded when long (see fold.ts). Open, it ends with a
// "Show less" link; folding from there keeps the prompt in view instead of
// leaving the reader somewhere below it.
export function PromptText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  useLayoutEffect(() => {
    if (!closing.current) return
    closing.current = false
    const el = box.current
    const scroller = el?.closest('.transcript')
    if (el && scroller && el.getBoundingClientRect().top < scroller.getBoundingClientRect().top) el.scrollIntoView({ block: 'start' })
  }, [open])
  const f = fold(text)
  if (!f) return <div className="prompt-text">{text}</div>
  return (
    <div className="prompt-text" ref={box}>
      {open ? (
        <>
          {text}
          <button
            className="fold-bar less"
            onClick={() => {
              closing.current = true
              setOpen(false)
            }}
          >
            Show less
          </button>
        </>
      ) : (
        <>
          {f.head}
          <button className="fold-bar" onClick={() => setOpen(true)} title="Show the whole prompt">
            {f.hidden}, show all
          </button>
          {f.tail}
        </>
      )}
    </div>
  )
}
