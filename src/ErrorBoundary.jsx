import { Component } from 'react';

/**
 * Catches render-time errors anywhere in the component tree so a single broken
 * page never blanks the whole app. Shows a recoverable fallback instead.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface the details in the console for debugging.
    console.error('AlphaEdge crashed:', error, info);
  }

  handleReset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#060d17',
          color: '#cbd5e1',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            background: '#0a1628',
            border: '1px solid #1e3a5a',
            borderRadius: 12,
            padding: 28,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 40, marginBottom: 8 }}>⬡</div>
          <h1 style={{ fontSize: 18, color: '#e2e8f0', marginBottom: 10 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 18 }}>
            A part of AlphaEdge ran into an error. Your saved data is safe — try reloading the
            view below.
          </p>
          <pre
            style={{
              fontSize: 11,
              color: '#f87171',
              background: '#060d17',
              border: '1px solid #1e3a5a',
              borderRadius: 8,
              padding: 12,
              textAlign: 'left',
              overflow: 'auto',
              maxHeight: 140,
              marginBottom: 18,
            }}
          >
            {String(error?.message || error)}
          </pre>
          <button
            onClick={this.handleReset}
            style={{
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
