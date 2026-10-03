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
