import { Component, type ReactNode } from 'react'

/** Shows a recoverable message instead of a blank screen if a component crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page">
        <h3>Something went wrong.</h3>
        <p className="meta">{this.state.error.message}</p>
        <p className="meta">Your chats are safe on this device.</p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    )
  }
}
