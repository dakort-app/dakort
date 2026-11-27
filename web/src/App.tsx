import { Home } from './Home'
import { useRoute } from './route'
import { useStore } from './store'
import { Workspace } from './Workspace'
import { buttonVariants } from '@/components/ui/button'

// No "finished" toast: it was found intrusive. The dots on the tabs and
// projects and the count in the page title say a session finished.
export function App() {
  const route = useRoute()
  const auth = useStore((s) => s.stream === 'auth')
  if (auth) {
    // A device without the cookie: the way in from here, not a pointer to
    // a link in a terminal the phone cannot see. The same card as the login
    // page it leads to (and the offline page).
    return (
      <main className="card-page">
        <div className="page-card">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <h1>Not logged in on this device</h1>
          <p>Log in with the password set on your computer, or open the login link Dakort printed when it started.</p>
          <a className={buttonVariants({ size: 'sm' })} href="/login">
            Log in
          </a>
        </div>
      </main>
    )
  }
  return route.page === 'folder' ? <Workspace key={route.folder} folder={route.folder} /> : <Home />
}
