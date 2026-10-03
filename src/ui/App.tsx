import { useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { useAuth, useConversations, useOnline, useSyncStatus } from '../hooks'
import { AdminPage } from './AdminPage'
import { ChatView } from './ChatView'
import { ModelPicker } from './ModelPicker'
import { SettingsPage } from './SettingsPage'
import { TelemetryHud } from './TelemetryHud'

/**
 * PLACEHOLDER UI. Functional but intentionally plain: it exists to prove every feature works
 * end-to-end. Replace anything in src/ui/ freely; all behavior lives behind src/hooks.
 */
export default function App() {
  const [showSidebar, setShowSidebar] = useState(false)
  return (
    <div className={`app ${showSidebar ? 'show-sidebar' : ''}`}>
      <Sidebar onNavigate={() => setShowSidebar(false)} />
      <div className="main">
        <TopBar onMenu={() => setShowSidebar((v) => !v)} />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/c/:id" element={<ChatRoute />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/admin" element={<AdminGuard />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  )
}

function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const { conversations, create, expiresIn } = useConversations()
  const { id } = useParams()
  const navigate = useNavigate()
  const { isAdmin } = useAuth()
  return (
    <aside className="sidebar">
      <button
        onClick={async () => {
          navigate(`/c/${await create()}`)
          onNavigate()
        }}
      >
        + New chat
      </button>
      {conversations.map((c) => (
        <Link key={c.id} to={`/c/${c.id}`} onClick={onNavigate} className={`conv ${c.id === id ? 'active' : ''}`}>
          {c.title ?? 'New chat'}
          <div className="meta">auto-deletes in {Math.ceil(expiresIn(c) / 86_400_000)}d</div>
        </Link>
      ))}
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Link to="/settings" onClick={onNavigate}>Settings</Link>
        {isAdmin && <Link to="/admin" onClick={onNavigate}>Admin console</Link>}
      </div>
    </aside>
  )
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const online = useOnline()
  const auth = useAuth()
  const sync = useSyncStatus()
  return (
    <header className="topbar">
      <button onClick={onMenu} aria-label="Menu">☰</button>
      <strong>Shreyan.ai</strong>
      <span className={`pill ${online ? 'ok' : 'warn'}`}>{online ? 'online' : 'offline'}</span>
      {auth.status === 'signedIn' && (
        <span className="pill" title={sync.error ?? ''}>
          sync: {sync.phase}
          {sync.realtime ? ' · live' : ''}
          {sync.pending ? ` · ${sync.pending} pending` : ''}
        </span>
      )}
      <ModelPicker />
      <TelemetryHud />
      <span style={{ marginLeft: 'auto' }} />
      {auth.status === 'signedIn' && (
        <>
          <span className="meta">
            {auth.user?.email} {auth.isAdmin && <b>(admin)</b>}
          </span>
          <button onClick={() => void auth.signOut()}>Sign out</button>
        </>
      )}
      {auth.status === 'signedOut' && <button onClick={() => void auth.signInWithGoogle()}>Sign in with Google to sync</button>}
      {auth.status === 'disabled' && <span className="meta">guest mode (cloud not configured)</span>}
    </header>
  )
}

function Home() {
  const { conversations, create } = useConversations()
  const navigate = useNavigate()
  if (conversations.length) return <Navigate to={`/c/${conversations[0].id}`} replace />
  return (
    <div className="page">
      <h2>Private AI that runs on your device</h2>
      <p>Pick a model above (downloaded once, then works offline), then start a chat.</p>
      <button onClick={async () => navigate(`/c/${await create()}`)}>Start a chat</button>
    </div>
  )
}

function ChatRoute() {
  const { id } = useParams()
  return <ChatView key={id} conversationId={id!} />
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
