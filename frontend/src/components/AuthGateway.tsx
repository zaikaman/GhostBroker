import React, { useState } from 'react';
import { connectWithWallet } from '../services/wallet-auth';
import type { AuthSession } from '../services/api-client';

interface AuthGatewayProps {
  onAuthenticated: (session: AuthSession) => void;
}

export function AuthGateway({ onAuthenticated }: AuthGatewayProps): React.JSX.Element {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleWalletConnect = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await connectWithWallet();
      onAuthenticated(result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet authorization failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-layout">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-copy">
          <p className="eyebrow">Terminal 3 Agent Authorization</p>
          <h1 id="auth-title" className="auth-title">GhostBroker</h1>
          <p className="auth-text">
            Authorize with your Web3 wallet to access the operator console. A cryptographic
            challenge will be issued and signed via your wallet to verify your identity.
          </p>
        </div>

        <div className="auth-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleWalletConnect}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Connecting...' : 'Connect Web3 Wallet'}
          </button>
        </div>

        {error && (
          <div className="status-badge error auth-error" role="alert">
            {error}
          </div>
        )}
      </section>
    </main>
  );
}
