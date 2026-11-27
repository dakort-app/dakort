import { useEffect, useState, type RefObject } from 'react'

// Whether a sideways scroller has more to show past its left or right
// edge, for a fade there (a phone shows no scroll bar until a swipe). The
// returned measure goes on the scroller's onScroll; a resize measures
// again by itself. deps: whatever changes the content's width.
export function useEdges(box: RefObject<HTMLElement | null>, deps: unknown[]) {
  const [edges, setEdges] = useState({ left: false, right: false })
  const measure = () => {
    const el = box.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }))
  }
  useEffect(() => {
    const el = box.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, deps)
  const attrs = { 'data-more-left': edges.left || undefined, 'data-more-right': edges.right || undefined }
  return { measure, attrs }
}
