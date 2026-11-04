import { Home } from './Home'
import { useRoute } from './route'
import { useStore } from './store'
import { Workspace } from './Workspace'

// No "finished" toast: it was found intrusive. The dots on the tabs and
// projects and the count in the page title say a session finished.
export function App() {
  const route = useRoute()
  const auth = useStore((s) => s.stream === 'auth')
  if (auth) {
    return (
      <div className="center">
        <p>Not logged in on this device.</p>
        <p className="faint">Open the login link the server printed when it started.</p>
      </div>
    )
  }
  return route.page === 'folder' ? <Workspace key={route.folder} folder={route.folder} /> : <Home />
}
