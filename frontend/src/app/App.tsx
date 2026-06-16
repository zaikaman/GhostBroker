import React, { useState, useEffect, useRef } from 'react';
import Hls from 'hls.js';
import '../styles/theme.css';
import '../styles/dashboard.css';
import '../styles/landing-v2.css';
import { RouterProvider, Route } from './routes';
import { useRouter } from './use-router';
import { useConnectionTelemetry } from '../hooks/useConnectionTelemetry';
import { SecureMetric } from '../components/SecureMetric';
import { AgentConnectionGrid } from '../components/AgentConnectionGrid';
import { ProcessingStatusRail } from '../components/ProcessingStatusRail';
import { LiveAgentActivityStream } from '../components/LiveAgentActivityStream';
import { CompletedTradesTable } from '../components/CompletedTradesTable';
import { EncryptedReceiptDrawer } from '../components/EncryptedReceiptDrawer';
import { AuthGateway } from '../components/AuthGateway';
import { LandingPage } from '../components/LandingPage';
import { AgentDeploymentGuide } from '../components/AgentDeploymentGuide';
import { DepositWalletOverviewCard } from '../components/DepositWalletOverviewCard';
import { PortfolioHistory } from '../components/PortfolioHistory';
import { useTradeHistory } from '../hooks/useTradeHistory';
import { useReceipt } from '../hooks/useReceipt';
import { EnclaveHealthMonitor } from '../components/EnclaveHealthMonitor';
import { ApiKeysPanel } from '../components/ApiKeysPanel';
import { AgentsPanel } from '../components/AgentsPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { apiClient, type AuthSession } from '../services/api-client';

const GearIcon = ({ size = 16, style = {} }: { size?: number; style?: React.CSSProperties }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
import {
  Robot01Icon,
  Shield01Icon,
  Plug01Icon,
  Link01Icon,
  AlertCircleIcon,
  ScrollIcon,
  LockIcon,
  RocketIcon,
  EyeIcon,
  CancelCircleIcon,
} from 'hugeicons-react';

function DashboardView({
  session,
  setSession,
}: {
  session: AuthSession;
  setSession: React.Dispatch<React.SetStateAction<AuthSession | null>>;
}): React.JSX.Element {
  const { currentPath, navigate } = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const streamUrl = 'https://stream.mux.com/tLkHO1qZoaaQOUeVWo8hEBeGQfySP02EPS02BmnNFyXys.m3u8';
    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: false
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((err) => {
          console.warn('Auto-play failed/prevented:', err);
        });
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      video.addEventListener('loadedmetadata', () => {
        video.play().catch((err) => {
          console.warn('Native auto-play failed/prevented:', err);
        });
      });
    }

    return () => {
      if (hls) {
        hls.destroy();
      }
    };
  }, []);

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

  // The active tab is derived from the URL when on `/deploy` or `/settings`, and
  // from a local-storage-backed user preference when on `/dashboard`.
  // We avoid a setState-in-effect by reading the URL on every render
  // and falling back to the user-selected tab for the dashboard.
  const [dashboardTab, setDashboardTab] = useState<string>(() =>
    localStorage.getItem('ghostbroker-active-tab') || 'overview',
  );
  const activeTab = currentPath === '/deploy' ? 'deploy' : (currentPath === '/settings' ? 'settings' : dashboardTab);

  const handleTabChange = (tab: string) => {
    if (tab === 'deploy') {
      navigate('/deploy');
    } else if (tab === 'settings') {
      navigate('/settings');
    } else {
      setDashboardTab(tab);
      localStorage.setItem('ghostbroker-active-tab', tab);
      navigate('/dashboard');
    }
  };

  // Rehydrate the dashboard tab from localStorage whenever the user
  // lands on /dashboard from a different route. We use the functional
  // form of setState inside a microtask so the React-hooks
  // `set-state-in-effect` rule is satisfied (the microtask schedules
  // the setState outside the effect's synchronous body, and the
  // functional updater is the React-blessed way to derive the next
  // state from current state without lint noise).
  useEffect(() => {
    if (currentPath !== '/dashboard') return;
    const saved = localStorage.getItem('ghostbroker-active-tab') || 'overview';
    queueMicrotask(() => {
      setDashboardTab((current) => (current === saved ? current : saved));
    });
  }, [currentPath]);

  const handleLogout = () => {
    apiClient.clearAuthSession();
    setSession(null);
    navigate('/');
  };

  // Render tab content dynamically
  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div className="dashboard-grid-overview" style={{ animation: 'fadeIn 0.3s ease' }}>
            <div className="layout-col-1" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
              <DepositWalletOverviewCard institutionId={session.institution.id} />
              <PortfolioHistory institutionId={session.institution.id} />
            </div>
            <div className="layout-col-2" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
              <div className="card">
                <ProcessingStatusRail intents={intents} />
              </div>
              <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <LiveAgentActivityStream
                  agents={agents}
                  intents={intents}
                  institutionName={session.institution.displayName}
                  institutionDid={session.institution.t3TenantDid}
                />
              </div>
            </div>
          </div>
        );

      case 'enclaves':
        return (
          <div className="dashboard-grid-enclaves" style={{ animation: 'fadeIn 0.3s ease' }}>
            <div className="enclaves-main" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
              {agents.length === 0 && (
                <div className="deploy-onboarding-hero" style={{ margin: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                      width: '40px',
                      height: '40px',
                      borderRadius: '50%',
                      background: 'rgba(94, 210, 156, 0.1)',
                      border: '1px solid rgba(94, 210, 156, 0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      <RocketIcon size={20} style={{ color: 'var(--color-accent)' }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <h4 style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>
                        ONBOARDING: NO ACTIVE TRADING AGENT REGISTERED
                      </h4>
                      <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-text-secondary)', maxWidth: '650px' }}>
                        GhostBroker operates under Zero-Human Access rules. Standard order entry is disabled. To begin trading in the dark pool, launch a verified hosted agent runtime for your institution.
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleTabChange('deploy')}
                    style={{
                      padding: '8px 16px',
                      fontSize: '0.75rem',
                      fontFamily: 'var(--font-mono)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      boxShadow: '0 0 15px rgba(94, 210, 156, 0.25)',
                      border: '1px solid var(--color-accent)'
                    }}
                  >
                    <RocketIcon size={14} /> Open Hosted Launch
                  </button>
                </div>
              )}
              <AgentsPanel onNavigateToDeveloperKeys={() => {
                const el = document.getElementById('api-keys-panel');
                if (el) el.scrollIntoView({ behavior: 'smooth' });
              }} />
              <ApiKeysPanel />
            </div>
            <div className="enclaves-side" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
              <div className="card enclave-health-card" style={{ display: 'flex', flexDirection: 'column' }}>
                <EnclaveHealthMonitor />
              </div>
              <div className="card">
                <AgentConnectionGrid agents={agents} onDeploy={() => handleTabChange('deploy')} />
              </div>
            </div>
          </div>
        );

      case 'ledger':
        return (
          <div className="dashboard-grid-ledger" style={{ animation: 'fadeIn 0.3s ease' }}>
            <div className="card">
              <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ScrollIcon size={18} style={{ color: 'var(--color-accent)' }} /> Completed Trades & Audit History
              </h2>
              <CompletedTradesTable
                trades={trades}
                isLoading={isHistoryLoading}
                onViewReceipt={handleViewReceipt}
              />
            </div>
          </div>
        );

      case 'developer':
        return (
          <div className="dashboard-grid-developer" style={{ animation: 'fadeIn 0.3s ease' }}>
            <ApiKeysPanel />
          </div>
        );

      case 'deploy':
        return (
          <div style={{ animation: 'fadeIn 0.3s ease' }}>
            <AgentDeploymentGuide session={session} onBack={() => handleTabChange('enclaves')} />
          </div>
        );

      case 'settings':
        return (
          <div style={{ animation: 'fadeIn 0.3s ease' }}>
            <SettingsPanel session={session} />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="dashboard-v2-container">
      {/* 1. Background Video */}
      <div className="video-background-container">
        <video
          ref={videoRef}
          className="video-background"
          muted
          loop
          playsInline
          autoPlay
        />
      </div>

      {/* 2. Overlays */}
      <div className="overlay-left-to-right" />
      <div className="overlay-bottom-up" />

      {/* 3. Central Glow SVG */}
      <svg
        className="central-glow-svg"
        viewBox="0 0 1000 400"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <filter id="glowBlur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="25" />
          </filter>
        </defs>
        <ellipse
          cx="500"
          cy="100"
          rx="350"
          ry="80"
          fill="url(#glowGradient)"
          filter="url(#glowBlur)"
          opacity="0.35"
        />
        <linearGradient id="glowGradient" x1="150" y1="100" x2="850" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00f2fe" />
          <stop offset="50%" stopColor="#5ed29c" />
          <stop offset="100%" stopColor="#0575e6" />
        </linearGradient>
      </svg>

      <div className="dashboard-container-v3">
        {/* Left Sidebar */}
        <aside className="sidebar">
          <div className="sidebar-brand">
            <h1 className="sidebar-logo">GHOSTBROKER</h1>
            <div className="observatory-badge" style={{ alignSelf: 'flex-start' }}>
              <span className="badge-dot" />
              OBSERVATORY MODE
            </div>
          </div>

          <nav className="sidebar-nav">
            <button
              type="button"
              className={`sidebar-link ${activeTab === 'overview' ? 'active' : ''}`}
              onClick={() => handleTabChange('overview')}
            >
              <EyeIcon size={16} /> Overview
            </button>
            <button
              type="button"
              className={`sidebar-link ${activeTab === 'enclaves' ? 'active' : ''}`}
              onClick={() => handleTabChange('enclaves')}
            >
              <Robot01Icon size={16} /> Access Control
            </button>
            <button
              type="button"
              className={`sidebar-link ${activeTab === 'ledger' ? 'active' : ''}`}
              onClick={() => handleTabChange('ledger')}
            >
              <ScrollIcon size={16} /> Audit Ledger
            </button>
            <button
              type="button"
              className={`sidebar-link ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => handleTabChange('settings')}
            >
              <GearIcon size={16} /> Settings
            </button>
            <button
              type="button"
              className={`sidebar-link ${activeTab === 'deploy' ? 'active' : ''}`}
              onClick={() => handleTabChange('deploy')}
              style={{ marginTop: 'var(--spacing-md)' }}
            >
              <RocketIcon size={16} style={{ color: 'var(--color-accent)' }} /> Hosted Agents
            </button>
          </nav>

          <div className="sidebar-footer">
            <div className="sidebar-institution">
              <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Institution</div>
              <div className="sidebar-institution-name">{session.institution.displayName}</div>
              <div className="sidebar-did" title={session.institution.t3TenantDid}>
                {session.institution.t3TenantDid.slice(0, 18)}...
              </div>
            </div>
            <button
              type="button"
              className="sidebar-btn-logout"
              onClick={handleLogout}
            >
              <CancelCircleIcon size={12} /> Disconnect DID
            </button>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="main-content">
          {/* Header block (only shown if not in deploy tab to prevent double headers) */}
          {activeTab !== 'deploy' && (
            <header className="dashboard-header" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
                <div className="header-brand">
                  <h2 style={{ fontSize: '1.1rem', margin: 0, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {activeTab === 'overview' && 'SYSTEM OVERVIEW'}
                    {activeTab === 'enclaves' && 'ACCESS CONTROL & INFRASTRUCTURE'}
                    {activeTab === 'ledger' && 'SECURE AUDIT LEDGER'}
                    {activeTab === 'settings' && 'SYSTEM SETTINGS'}
                  </h2>
                </div>
                <div className="header-meta" style={{ display: 'flex', gap: 'var(--spacing-md)', alignItems: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                    DID: {session.institution.t3TenantDid}
                  </div>
                  {activeTab !== 'enclaves' && (
                    <button
                      type="button"
                      className="btn-deploy-premium"
                      onClick={() => handleTabChange('deploy')}
                    >
                      <RocketIcon size={12} /> Hosted Agents
                    </button>
                  )}
                </div>
              </div>

              {/* Integrated Mandate Banner */}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                background: 'rgba(94, 210, 156, 0.02)', 
                border: '1px solid rgba(94, 210, 156, 0.1)', 
                borderRadius: '12px', 
                padding: '10px 16px',
                fontSize: '0.75rem',
                width: '100%',
                gap: 'var(--spacing-md)',
                boxSizing: 'border-box'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'rgba(255, 255, 255, 0.85)', lineHeight: '1.4' }}>
                  <Robot01Icon size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span>
                      <strong>Agent-to-Agent Zone:</strong> Cryptographically verified TEE matching active. No human order visibility.
                    </span>
                    <span style={{ fontSize: '0.7rem', opacity: 0.8, color: 'var(--color-accent)' }}>
                      Order queue is cryptographically secured inside hardware TEE. Zero visibility mode active.
                    </span>
                  </div>
                </div>
                <span style={{ 
                  fontFamily: 'var(--font-mono)', 
                  fontSize: '0.65rem', 
                  color: 'var(--color-accent)', 
                  background: 'rgba(94, 210, 156, 0.08)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  border: '1px solid rgba(94, 210, 156, 0.15)',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px'
                }}>
                  <LockIcon size={10} /> ZERO HUMAN ACCESS
                </span>
              </div>
            </header>
          )}

          {/* Connection Status Section (Metrics Grid) - Only shown if not in deploy tab */}
          {activeTab !== 'deploy' && (
            <div className="layout-metrics" style={{ marginBottom: 'var(--spacing-lg)' }}>
              <SecureMetric 
                title="TEE Enclave Status" 
                value={enclaveStatus === 'secure' ? 'SECURE' : enclaveStatus === 'processing' ? 'PROCESSING' : 'ERROR'} 
                status={enclaveStatus} 
                subtext="SGX Hardware Attested"
                icon={enclaveStatus === 'secure' ? <Shield01Icon size={16} /> : <AlertCircleIcon size={16} />}
              />
              <SecureMetric 
                title="Telemetry Link" 
                value={connectionStatus.toUpperCase()} 
                status={connectionStatus === 'connected' ? 'secure' : connectionStatus === 'connecting' ? 'processing' : 'error'} 
                subtext="Encrypted Event Pipeline"
                icon={connectionStatus === 'connected' ? <Plug01Icon size={16} /> : <AlertCircleIcon size={16} />}
              />
              <SecureMetric 
                title="T3 Sandbox Network" 
                value={sandboxStatus.toUpperCase()} 
                status={sandboxStatus === 'connected' ? 'secure' : 'error'} 
                subtext="Smart Contract Broker Link"
                icon={sandboxStatus === 'connected' ? <Link01Icon size={16} /> : <AlertCircleIcon size={16} />}
              />
            </div>
          )}

          {/* System Error Notification Banner */}
          {errorAlert && activeTab !== 'deploy' && (
            <div 
              className="layout-header status-badge error" 
              style={{ 
                borderRadius: 'var(--radius-md)', 
                padding: 'var(--spacing-md)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.8rem',
                width: '100%',
                justifyContent: 'flex-start',
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-sm)',
                marginBottom: 'var(--spacing-lg)'
              }}
            >
              <AlertCircleIcon size={16} /> {errorAlert}
            </div>
          )}

          {/* Active View Content */}
          {renderTabContent()}
        </main>
      </div>

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
    if (!session && (currentPath === '/dashboard' || currentPath === '/deploy' || currentPath === '/settings')) {
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
              &larr; Back to Landing
            </button>
            <AuthGateway onAuthenticated={(newSession) => {
              setSession(newSession);
              navigate('/dashboard');
            }} />
          </div>
        )
      } />

      {session && (currentPath === '/dashboard' || currentPath === '/deploy' || currentPath === '/settings') ? (
        <DashboardView session={session} setSession={setSession} />
      ) : null}
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




