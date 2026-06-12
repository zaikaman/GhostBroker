import React from 'react';
import '../styles/theme.css';
import '../styles/dashboard.css';
import { RouterProvider, Route } from './routes';

function DashboardView(): React.JSX.Element {
  return (
    <div className="dashboard-layout">
      {/* Header Section */}
      <header className="layout-header dashboard-header">
        <div className="header-brand">
          <h1 className="header-title">GhostBroker</h1>
        </div>
        <div className="header-meta">
          <span className="status-badge secure">
            <span className="pulse-dot"></span>
            TEE Enclave: SECURE
          </span>
          <span className="status-badge secure">
            Telemetry: Connected
          </span>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
            DID: did:t3:vcb_institutional_darkpool_operator
          </div>
        </div>
      </header>

      {/* Main Left Section: Blind Order Submission */}
      <main className="layout-left card">
        <h2 className="card-title">
          <span>🛡️</span> Blind Order Submission
        </h2>
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="form-group">
            <label className="form-label" htmlFor="assetTicker">Asset Ticker</label>
            <input
              type="text"
              id="assetTicker"
              className="form-input"
              placeholder="e.g. BTC-USD, ETH-USD"
              disabled
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="direction">Direction</label>
            <select id="direction" className="form-select" disabled>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="limitPrice">Limit Price</label>
            <input
              type="number"
              id="limitPrice"
              className="form-input"
              placeholder="0.00"
              disabled
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="volume">Volume</label>
            <input
              type="number"
              id="volume"
              className="form-input"
              placeholder="0.00"
              disabled
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled>
              Submit Sealed Intent
            </button>
          </div>
        </form>
      </main>

      {/* Main Right Section: Sealed Order Book */}
      <section className="layout-right card">
        <h2 className="card-title">
          <span>👁️‍🗨️</span> Sealed Order Book
        </h2>
        <div className="radar-container">
          <div className="radar-sweep"></div>
          <div className="radar-grid"></div>
          <div className="radar-grid-inner"></div>
          <div className="radar-crosshair-h"></div>
          <div className="radar-crosshair-v"></div>
          <div className="radar-message">
            <div className="radar-message-title">Enclave Vault Sealed</div>
            <div className="radar-message-text">
              Order queue is cryptographically secured inside hardware TEE. Zero visibility mode active.
            </div>
          </div>
        </div>
      </section>

      {/* Bottom Section: Completed Trades & Audit History */}
      <footer className="layout-bottom card">
        <h2 className="card-title">
          <span>📜</span> Completed Trades & Audit History
        </h2>
        <div className="table-container" style={{ padding: 'var(--spacing-lg)', textAlign: 'center', color: 'var(--color-text-muted)' }}>
          Secure connection established. Waiting for completed trades...
        </div>
      </footer>
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <RouterProvider>
      <Route path="/" element={<DashboardView />} />
      <Route path="/dashboard" element={<DashboardView />} />
    </RouterProvider>
  );
}

export default App;
