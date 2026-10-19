import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  /** Render the app. `skipRestore` asks it to start empty instead of restoring the autosave. */
  children: (opts: { key: number; skipRestore: boolean }) => ReactNode;
}

interface State {
  error: Error | null;
  key: number;
  skipRestore: boolean;
}

/**
 * Catches a render crash (for example a malformed circuit) and shows what
 * happened instead of a white window. "Reload last autosave" remounts the
 * app, which restores the autosave as it does at startup.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: 0, skipRestore: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('E101 crashed:', error, info.componentStack);
  }

  private restart(skipRestore: boolean) {
    this.setState((s) => ({ error: null, key: s.key + 1, skipRestore }));
  }

  render() {
    const { error, key, skipRestore } = this.state;
    if (!error) return this.props.children({ key, skipRestore });
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-box">
          <h1>Something went wrong</h1>
          <p>
            E101 hit an error and stopped drawing the board. Your work up to the
            last autosave (about a second before this) is kept.
          </p>
          <pre className="crash-detail">{error.message || String(error)}</pre>
          <div className="modal-actions">
            <button type="button" className="modal-btn primary" onClick={() => this.restart(false)}>
              Reload last autosave
            </button>
            <button type="button" className="modal-btn" onClick={() => this.restart(true)}>
              Start with an empty board
            </button>
          </div>
        </div>
      </div>
    );
  }
}
