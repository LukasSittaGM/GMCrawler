import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
  message: string;
  stack: string | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    message: '',
    stack: null
  };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || 'Unknown error',
      stack: error.stack ?? null
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error('[error-boundary]', error, info.componentStack);
    }
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <main className="container">
        <h1>Něco se pokazilo</h1>
        <p><strong>Detail chyby:</strong><br />{this.state.message}</p>
        {import.meta.env.DEV && this.state.stack && (
          <pre className="error-stack">{this.state.stack}</pre>
        )}
        <div className="row-actions">
          <Link className="button" to="/">Zpět na seznam dávek</Link>
          <button className="button" type="button" onClick={() => window.location.reload()}>Obnovit stránku</button>
        </div>
      </main>
    );
  }
}
