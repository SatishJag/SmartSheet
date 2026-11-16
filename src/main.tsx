import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initTheme } from './ui/theme'

initTheme() // the inline script in index.html already applied it before first paint; this syncs the meta tag + storage

// Links in e-mails open /u/<token> (update request) or /a/<token> (approval): a public page with no
// shell and no sign-in, so it is chosen before the app (and its anonymous session) starts.
const PublicRequestPage = lazy(() => import('./automation/public/PublicRequestPage').then((m) => ({ default: m.PublicRequestPage })))
const link = /^\/(u|a)\/([A-Za-z0-9_-]{20,100})\/?$/.exec(window.location.pathname)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {link ? (
      <Suspense fallback={<p className="auth-status">Loading...</p>}>
        <PublicRequestPage kind={link[1] as 'u' | 'a'} token={link[2]} />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
