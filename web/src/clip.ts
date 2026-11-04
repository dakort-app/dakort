// copyText puts text on the clipboard. The clipboard API needs a secure
// page, which plain http over Tailscale is not; a selected textarea and
// execCommand still work there.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length) // iOS ignores select() alone
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
