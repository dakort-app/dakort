// keyboard.ts marks the page while a phone's on-screen keyboard is up
// (data-keyboard on <html>), read from how much of the window the visual
// viewport still shows: iOS shrinks that, not the window. The composer
// drops its home-indicator inset then, which would only leave a gap above
// the keys.
export function startKeyboard() {
  const vv = window.visualViewport
  if (!vv || !matchMedia('(pointer: coarse)').matches) return
  const check = () => {
    const up = vv.height < window.innerHeight * 0.8
    if (up !== document.documentElement.hasAttribute('data-keyboard')) document.documentElement.toggleAttribute('data-keyboard', up)
  }
  vv.addEventListener('resize', check)
  check()
}
