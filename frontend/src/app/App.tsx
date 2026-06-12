import React, { useState, useEffect } from 'react';
import '../styles/theme.css';
import '../styles/dashboard.css';
import { RouterProvider, Route, useRouter } from './routes';
import { useConnectionTelemetry } from '../hooks/useConnectionTelemetry';
import { SecureMetric } from '../components/SecureMetric';
import { AgentConnectionGrid } from '../components/AgentConnectionGrid';
import { ProcessingStatusRail } from '../components/ProcessingStatusRail';
import { LiveAgentActivityStream } from '../components/LiveAgentActivityStream';
import { CompletedTradesTable } from '../components/CompletedTradesTable';
import { EncryptedReceiptDrawer } from '../components/EncryptedReceiptDrawer';
import { AuthGateway } from '../components/AuthGateway';
import { LandingPage } from '../components/LandingPage';
import { useTradeHistory } from '../hooks/useTradeHistory';
import { useReceipt } from '../hooks/useReceipt';
import { apiClient, type AuthSession } from '../services/api-client';

function DashboardView({ session }: { session: AuthSession }): React.JSX.Element {
  const {
    connectionStatus,
    enclaveStatus,
    sandboxStatus,
    agents,
    intents,
    errorAlert
  } = useConnectionTelemetry();

  // Scoped trade history
  const { trades, isLoading: isHistoryLoading } = useTradeHistory();

  // Receipt drawer state
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(() =>
    localStorage.getItem('ghostbroker-selected-receipt-id')
  );
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(() =>
    localStorage.getItem('ghostbroker-is-drawer-open') === 'true'
  );

  const { receipt, isLoading: isReceiptLoading, error: receiptError } = useReceipt(selectedReceiptId);

  const handleViewReceipt = (receiptId: string) => {
    setSelectedReceiptId(receiptId);
    setIsDrawerOpen(true);
    localStorage.setItem('ghostbroker-selected-receipt-id', receiptId);
    localStorage.setItem('ghostbroker-is-drawer-open', 'true');
  };

  const handleCloseDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedReceiptId(null);
    localStorage.removeItem('ghostbroker-selected-receipt-id');
    localStorage.removeItem('ghostbroker-is-drawer-open');
  };

  return (
    <div className="dashboard-layout">
      {/* Header Section */}
      <header className="layout-header dashboard-header">
        <div className="header-brand">
          <h1 className="header-title">GhostBroker</h1>
        </div>
        <div className="header-meta" style={{ display: 'flex', gap: 'var(--spacing-md)', alignItems: 'center' }}>
          <div className="observatory-badge">
            <span className="badge-dot"></span>
            OBSERVATORY MODE
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
            DID: {session.institution.t3TenantDid}
          </div>
        </div>
      </header>

      {/* Agent-to-Agent Mandate Banner */}
      <div className="layout-header a2a-banner">
        <div className="a2a-banner-icon">🤖</div>
        <div className="a2a-banner-content">
          <strong>Agent-to-Agent Dark Pool</strong>
          <span>This is an autonomous trading zone. Humans may only observe — all order placement, matching, and settlement is executed by cryptographically verified AI agents inside the TEE enclave. No human intervention is permitted during active trading.</span>
        </div>
        <div className="a2a-banner-badge">
          <span className="status-badge secure" style={{ fontSize: '0.65rem' }}>
            🔒 ZERO HUMAN ACCESS
          </span>
        </div>
      </div>

      {/* Connection Status Section (Metrics Rail) */}
      <div className="layout-header" style={{ gridColumn: 'span 2', display: 'flex', gap: 'var(--spacing-md)', flexWrap: 'wrap', marginTop: '-8px' }}>
        <SecureMetric 
          title="TEE Enclave Status" 
          value={enclaveStatus === 'secure' ? 'SECURE' : enclaveStatus === 'processing' ? 'PROCESSING' : 'ERROR'} 
          status={enclaveStatus} 
          subtext="SGX Hardware Attested"
          icon="🛡️"
        />
        <SecureMetric 
          title="Telemetry Link" 
          value={connectionStatus.toUpperCase()} 
          status={connectionStatus === 'connected' ? 'secure' : connectionStatus === 'connecting' ? 'processing' : 'error'} 
          subtext="Encrypted Event Pipeline"
          icon="🔌"
        />
        <SecureMetric 
          title="T3 Sandbox Network" 
          value={sandboxStatus.toUpperCase()} 
          status={sandboxStatus === 'connected' ? 'secure' : 'error'} 
          subtext="Smart Contract Broker Link"
          icon="⛓️"
        />
      </div>

      {/* System Error Notification Banner */}
      {errorAlert && (
        <div 
          className="layout-header status-badge error" 
          style={{ 
            gridColumn: 'span 2', 
            borderRadius: 'var(--radius-md)', 
            padding: 'var(--spacing-md)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            width: '100%',
            justifyContent: 'flex-start',
            boxSizing: 'border-box'
          }}
        >
          🚨 {errorAlert}
        </div>
      )}

      {/* Main Left Section: Sealed Order Book */}
      <main className="layout-left card">
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
              Sealed matching core is cryptographically secured inside hardware TEE. Zero visibility mode active.
            </div>
          </div>
        </div>
      </main>

      {/* Main Right Section: Live Telemetry & Connected Agents */}
      <section className="layout-right" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
        {/* Live Agent Activity Stream */}
        <div className="card">
          <LiveAgentActivityStream
            agents={agents}
            intents={intents}
            institutionName={session.institution.displayName}
            institutionDid={session.institution.t3TenantDid}
          />
        </div>

        {/* Processing Status Rail */}
        <div className="card">
          <ProcessingStatusRail intents={intents} />
        </div>

        {/* Admitted Agents Connection Grid */}
        <div className="card">
          <AgentConnectionGrid agents={agents} />
        </div>
      </section>

      {/* Bottom Section: Completed Trades & Audit History */}
      <footer className="layout-bottom card">
        <h2 className="card-title">
          <span>📜</span> Completed Trades & Audit History
        </h2>
        <CompletedTradesTable
          trades={trades}
          isLoading={isHistoryLoading}
          onViewReceipt={handleViewReceipt}
        />
      </footer>

      {/* Encrypted Audit Receipt Drawer */}
      <EncryptedReceiptDrawer
        receiptId={selectedReceiptId}
        isOpen={isDrawerOpen}
        onClose={handleCloseDrawer}
        receipt={receipt}
        isLoading={isReceiptLoading}
        error={receiptError}
      />
    </div>
  );
}

function AppContent({
  session,
  setSession,
}: {
  session: AuthSession | null;
  setSession: React.Dispatch<React.SetStateAction<AuthSession | null>>;
}): React.JSX.Element {
  const { currentPath, navigate } = useRouter();

  // Redirect/Route guard logic based on authentication state
  useEffect(() => {
    if (!session && (currentPath === '/dashboard' || currentPath === '/settings')) {
      navigate('/');
    } else if (session && (currentPath === '/' || currentPath === '/auth')) {
      navigate('/dashboard');
    }
  }, [session, currentPath, navigate]);

  return (
    <>
      <Route path="/" element={
        session ? null : <LandingPage onLaunch={() => navigate('/auth')} />
      } />
      
      <Route path="/auth" element={
        session ? null : (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigate('/')}
              style={{
                position: 'absolute',
                top: '20px',
                left: '20px',
                zIndex: 10,
                fontSize: '0.75rem',
                padding: 'var(--spacing-xs) var(--spacing-md)'
              }}
            >
              ← Back to Landing
            </button>
            <AuthGateway onAuthenticated={(newSession) => {
              setSession(newSession);
              navigate('/dashboard');
            }} />
          </div>
        )
      } />

      <Route path="/dashboard" element={
        session ? <DashboardView session={session} /> : null
      } />
    </>
  );
}

export function App(): React.JSX.Element {
  const [session, setSession] = useState<AuthSession | null>(() => apiClient.getAuthSession());

  return (
    <RouterProvider>
      <AppContent session={session} setSession={setSession} />
    </RouterProvider>
  );
}

export default App;
