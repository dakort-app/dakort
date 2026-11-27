import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AskHost } from './ask'
import { startStore } from './store'
import { startKeyboard } from './keyboard'
import { startModal } from './modal'
import { startTips } from './tips'
import './index.css'
import './theme'

startStore()
startTips()
startKeyboard()
startModal()
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <AskHost />
  </>,
)

// No service worker: one that a phone installed from an earlier version is
// removed with its saved copies (see public/sw.js). The home-screen app
// needs only the manifest and the icons.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((rs) => rs.forEach((r) => r.unregister()))
    .catch(() => {})
  if ('caches' in window) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {})
}
