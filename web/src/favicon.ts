// The browser tab's icon says what the agents are doing, each state by a
// shape and a tone of its own, so it reads at 16 px among other sites'
// icons and not by hue alone: the ink d on Dakort's lime square when all
// is quiet (light), inverted to a lime d on an ink square while a turn
// runs in this tab's folder (dark), and a round green disc, the app's
// accent (--primary), when one finished there that nobody has looked at
// yet (see showIcon in store.ts). Done is the one that asks for you, so it
// is the one that changes shape. In a dark browser the disc is a brighter
// green with a dark d, so it does not sink into a dark tab strip and still
// differs in tone from the idle lime. It was cobalt until the redesign
// made green the one accent.

export type IconState = 'idle' | 'run' | 'done'

const lime = '#c7f24f'
const ink = '#14170e'
const green = '#4d7c0f'
const greenDark = '#84cc16'

// The d: a bowl and a stem cut like a highlighter's tip. public/favicon.svg
// is the idle one, drawn alike.
const D = 'M40 13L48 8V56H40V53.86A16 16 0 1 1 40 26.14ZM32 32a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z'
const d = (color: string) => `<path fill="${color}" fill-rule="evenodd" d="${D}"/>`

const tile = (fill: string) => `<rect width="64" height="64" rx="14" fill="${fill}"/>`

const bodies: Record<IconState, string> = {
  idle: tile(lime) + d(ink),
  run: tile(ink) + d(lime),
  // The d a little smaller, to sit inside the round edge.
  done:
    `<style>.b{fill:${green}}.f{fill:#fff}@media (prefers-color-scheme:dark){.b{fill:${greenDark}}.f{fill:${ink}}}</style>` +
    `<circle class="b" cx="32" cy="32" r="32"/><path class="f" fill-rule="evenodd" transform="translate(3.2 1.6) scale(.9)" d="${D}"/>`,
}

export function faviconSVG(st: IconState): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' + bodies[st] + '</svg>'
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
