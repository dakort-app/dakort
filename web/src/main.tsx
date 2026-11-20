import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startStore } from './store'
import './styles.css'
import './theme'

startStore()
createRoot(document.getElementById('root')!).render(<App />)

// The service worker (public/sw.js) makes the app installable on a phone
// and shows a plain page when the server can't be reached. Browsers allow
// one on https (Tailscale Serve's address) and on localhost only.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
