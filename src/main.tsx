import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import { initAuth } from './core/auth'
import { getSelectedModelKey, initDevice, loadModel } from './core/llm/engine'
import { startLocalPurgeSchedule } from './core/privacy'
import App from './ui/App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './ui/base.css'

registerSW({ immediate: true })

// When the service worker first takes control (or updates), the page was loaded without the
// isolation headers it adds. Reload once so multi-threaded inference is available.
if ('serviceWorker' in navigator && !window.crossOriginIsolated) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    try {
      if (sessionStorage.getItem('coi-reloaded')) return
      sessionStorage.setItem('coi-reloaded', '1')
    } catch {
      return
    }
    window.location.reload()
  })
}
startLocalPurgeSchedule()
void initAuth()
void initDevice().then(() => {
  // Re-open the last model automatically; it is already cached, so this works offline.
  const last = getSelectedModelKey()
  if (last) loadModel(last).catch(() => {})
})
void navigator.storage?.persist?.()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
