// The browser tab's icon says what the agents are doing, through the d
// itself: white on blue when all is quiet, orange on blue while a turn
// runs in this tab's folder (an orange contour alone was too faint at
// 16 px), and white on an orange tile when one finished
// there that nobody has looked at yet (see showIcon in store.ts). Done is
// the loud one: it is the state that asks for you.

export type IconState = 'idle' | 'run' | 'done'

const orange = '#f08a4b'

// The d: a ring and a stem.
const d = (color: string) =>
  `<circle cx="26" cy="38" r="10" fill="none" stroke="${color}" stroke-width="7.5"/>` +
  `<rect x="34" y="10" width="7.5" height="42" rx="3.75" fill="${color}"/>`

const tile = (fill: string) => `<rect width="64" height="64" rx="14" fill="${fill}"/>`

const bodies: Record<IconState, string> = {
  idle: tile('url(#g)') + d('#fff'), // public/favicon.svg is this one, drawn alike
  run: tile('url(#g)') + d(orange),
  done: tile(orange) + d('#fff'),
}

export function faviconSVG(st: IconState): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8fd0"/><stop offset="1" stop-color="#2d5a92"/></linearGradient></defs>' +
    bodies[st] +
    '</svg>'
  )
}

let shown: IconState = 'idle' // what index.html's favicon.svg shows
export function showFavicon(st: IconState) {
  if (st === shown) return
  shown = st
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  link.href = 'data:image/svg+xml,' + encodeURIComponent(faviconSVG(st))
  link.dataset.state = st // for the browser checks
}
