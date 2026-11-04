import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startStore } from './store'
import './styles.css'
import './theme'

startStore()
createRoot(document.getElementById('root')!).render(<App />)
