import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth, useConversations, useModel, useOnline, usePageReporting, useSyncStatus, useTabs } from '../hooks'
import { AdminPage } from './AdminPage'
import { ChatView } from './ChatView'
import { DetailsPanel } from './DetailsPanel'
import { SettingsPage } from './SettingsPage'

/**
 * PLACEHOLDER UI. Functional and tidy, but meant to be replaced by the final design.
 * All behavior lives behind src/hooks.
 */
export default function App() {
  const [drawer, setDrawer] = useState(false)
  const [details, setDetails] = useState(() => {
    try {
      return localStorage.getItem('shreyan.details') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('shreyan.details', details ? '1' : '0')
    } catch {
      // preference just won't persist
    }
  }, [details])
  usePageReporting(useLocation().pathname)

  return (
    <div className="app">
      <Header onMenu={() => setDrawer(true)} details={details} onToggleDetails={() => setDetails((d) => !d)} />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/c/:id" element={<ChatRoute details={details} />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminGuard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {drawer && <HistoryDrawer onClose={() => setDrawer(false)} />}
    </div>
  )
}

function shortModel(label: string | undefined): string {
  if (!label) return 'No model'
  return label.replace(/\s*\(.*\)\s*$/, '').replace(/^Ollama\s+/, '')
}

function Header({ onMenu, details, onToggleDetails }: { onMenu: () => void; details: boolean; onToggleDetails: () => void }) {
  const online = useOnline()
  const sync = useSyncStatus()
  const auth = useAuth()
  const model = useModel()
  const dot = !online ? 'warn' : sync.phase === 'error' ? 'bad' : 'ok'
  const dotTitle = !online ? 'Offline: everything still works on this device' : auth.status === 'signedIn' ? `Online · sync ${sync.phase}` : 'Online'
  const chip =
    model.status === 'loading'
      ? `Loading ${Math.round((model.progress?.fraction ?? 0) * 100)}%`
      : model.status === 'ready'
        ? shortModel(model.spec?.label)
        : 'Choose model'
  return (
    <header className="header">
      <button className="icon" onClick={onMenu} aria-label="Chat history">☰</button>
      <Link to="/" className="brand">Shreyan.ai</Link>
      <span className={`dot ${dot}`} title={dotTitle} aria-label={dotTitle} />
      <span className="spacer" />
      <button className={`chip ${model.status === 'error' ? 'bad' : ''}`} onClick={onToggleDetails} title="Model and details">
        {chip}
      </button>
      <button className={`icon ${details ? 'on' : ''}`} onClick={onToggleDetails} aria-label="Show details" aria-pressed={details}>
        ⚙
      </button>
    </header>
  )
}

function Tabs() {
  const tabs = useTabs()
  const navigate = useNavigate()
  const strip = useRef<HTMLElement>(null)
  // Keep the active tab visible when there are more tabs than fit on screen.
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('.tab.active')
    if (el) {
      el.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
  }, [tabs.activeId, tabs.tabs.length])
  return (
    <nav className="tabs" aria-label="Open chats" ref={strip}>
      {tabs.tabs.map((c) => (
        <div key={c.id} className={`tab ${c.id === tabs.activeId ? 'active' : ''}`}>
          <button className="tab-title" onClick={() => navigate(`/c/${c.id}`)} title={c.title ?? 'New chat'}>
            {c.title ?? 'New chat'}
          </button>
          <button
            className="tab-close"
            aria-label="Close tab"
            onClick={async () => {
              const next = await tabs.close(c.id)
              if (c.id === tabs.activeId) navigate(next.active ? `/c/${next.active}` : '/')
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" aria-label="New tab" onClick={async () => navigate(`/c/${await tabs.newTab()}`)}>
        +
      </button>
    </nav>
  )
}

function ChatRoute({ details }: { details: boolean }) {
  const { id } = useParams()
  const tabs = useTabs()
  const { open } = tabs
  useEffect(() => {
    if (id) void open(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  return (
    <>
      <Tabs />
      {details && <DetailsPanel conversationId={id!} />}
      <ChatView key={id} conversationId={id!} />
    </>
  )
}

function Home() {
  const tabs = useTabs()
  const navigate = useNavigate()
  if (tabs.loading) return null
  if (tabs.activeId) return <Navigate to={`/c/${tabs.activeId}`} replace />
  return (
    <>
      <Tabs />
      <div className="page welcome">
        <h2>Private AI that runs on your device</h2>
        <p className="meta">Your chats stay on this device, sync when you sign in, and are deleted automatically after 15 days.</p>
        <button className="primary" onClick={async () => navigate(`/c/${await tabs.newTab()}`)}>Start a new chat</button>
      </div>
    </>
  )
}

function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const { conversations, expiresIn } = useConversations()
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const tabs = useTabs()
  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <b>Chats</b>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        <button
          className="primary"
          onClick={async () => {
            navigate(`/c/${await tabs.newTab()}`)
            onClose()
          }}
        >
          + New chat
        </button>
        <div className="history">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`history-item ${c.id === tabs.activeId ? 'active' : ''}`}
              onClick={() => {
                navigate(`/c/${c.id}`)
                onClose()
              }}
            >
              <span>{c.title ?? 'New chat'}</span>
              <span className="meta">deletes in {Math.ceil(expiresIn(c) / 86_400_000)}d</span>
            </button>
          ))}
          {!conversations.length && <p className="meta">No chats yet.</p>}
        </div>
        <div className="drawer-foot">
          <Link to="/settings" onClick={onClose}>Settings</Link>
          {isAdmin && <Link to="/admin" onClick={onClose}>Admin console</Link>}
        </div>
      </aside>
    </div>
  )
}

function AdminGuard() {
  const { status, isAdmin, roleVerified } = useAuth()
  if (status === 'loading' || (status === 'signedIn' && isAdmin && !roleVerified && navigator.onLine)) {
    return <div className="page">Checking access…</div>
  }
  // UX guard only: the data behind this page is protected by Postgres RLS + admin RPC checks.
  if (!isAdmin) return <div className="page">403 · Admin access required.</div>
  return <AdminPage />
}
