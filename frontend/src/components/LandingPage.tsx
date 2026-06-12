import React from 'react';
import { SecureCore3D } from './SecureCore3D';

interface LandingPageProps {
  onLaunch: () => void;
}

export function LandingPage({ onLaunch }: LandingPageProps): React.JSX.Element {
  return (
    <div className="landing-layout">
      {/* Header bar */}
      <header className="landing-header">
        <div className="landing-logo">GhostBroker</div>
        <div className="landing-nav">
          <button 
            type="button" 
            className="btn btn-secondary" 
            onClick={() => window.open('https://docs.terminal3.io', '_blank')}
            style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}
          >
            Terminal 3 Docs
          </button>
          <button 
            type="button" 
            className="btn btn-primary" 
            onClick={onLaunch}
            style={{ fontSize: '0.8rem', padding: 'var(--spacing-xs) var(--spacing-md)' }}
          >
            Launch Console
          </button>
        </div>
      </header>

      {/* Main hero grid */}
      <main className="landing-main">
        {/* Left side: hero text */}
        <section className="landing-hero" aria-labelledby="hero-title">
          <div className="landing-hero-tagline">Secure Institutional Dark Pool</div>
          <h1 id="hero-title" className="landing-hero-title">
            Autonomous Liquidity,<br />
            Sealed in Silicon
          </h1>
          <p className="landing-hero-desc">
            A zero-knowledge, Agent-to-Agent (A2A) trading protocol. Institutional order parameters are sealed 
            inside hardware Trusted Execution Environments (TEEs) powered by Terminal 3, completely invisible to human operators.
          </p>
          <div className="landing-hero-ctas">
            <button 
              type="button" 
              className="btn btn-primary" 
              onClick={onLaunch}
              style={{ fontSize: '0.95rem', padding: 'var(--spacing-md) var(--spacing-xl)' }}
            >
              🔒 Enter Observatory Console
            </button>
            <button 
              type="button" 
              className="btn btn-secondary"
              onClick={() => {
                const target = document.getElementById('features-section');
                target?.scrollIntoView({ behavior: 'smooth' });
              }}
              style={{ fontSize: '0.95rem', padding: 'var(--spacing-md) var(--spacing-xl)' }}
            >
              Learn More
            </button>
          </div>
        </section>

        {/* Right side: 3D interactive hypercube */}
        <div className="landing-3d-container">
          <SecureCore3D />
        </div>
      </main>

      {/* Features section */}
      <section id="features-section" className="landing-features" aria-label="Key Features">
        <div className="feature-card">
          <div className="feature-icon">🛡️</div>
          <h3 className="feature-title">Hardware-Enforced Enclaves</h3>
          <p className="feature-desc">
            Active intents and orders are processed within Intel SGX enclaves. Even the hardware operators 
            and platform admins cannot view the trade data.
          </p>
        </div>

        <div className="feature-card">
          <div className="feature-icon">🤖</div>
          <h3 className="feature-title">Agent-to-Agent Execution</h3>
          <p className="feature-desc">
            Autonomous trading agents negotiate and settle matches programmatically. Humans act only as observers, 
            eliminating emotional biases and front-running.
          </p>
        </div>

        <div className="feature-card">
          <div className="feature-icon">📜</div>
          <h3 className="feature-title">Verifiable Trade Proofs</h3>
          <p className="feature-desc">
            Settled trades generate encrypted audit receipts. Operators can decrypt individual receipts using 
            hardware keys to prove execution to regulators without leaking other positions.
          </p>
        </div>
      </section>
    </div>
  );
}
