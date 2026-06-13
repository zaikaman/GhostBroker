import React, { useState, useEffect, useRef } from 'react';
import Hls from 'hls.js';
import '../styles/theme.css';
import '../styles/dashboard.css';
import '../styles/landing-v2.css';
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
import { AgentDeploymentGuide } from '../components/AgentDeploymentGuide';
import { PortfolioCard } from '../components/PortfolioCard';
import { PortfolioHistory } from '../components/PortfolioHistory';
import { useTradeHistory } from '../hooks/useTradeHistory';
import { useReceipt } from '../hooks/useReceipt';
import { apiClient, type AuthSession } from '../services/api-client';
import {
  Robot01Icon,
  Shield01Icon,
  Plug01Icon,
  Link01Icon,
  AlertCircleIcon,
  ScrollIcon,
  LockIcon
} from 'hugeicons-react';

function AgentDeployView({ session }: { session: AuthSession }): React.JSX.Element {
  const { navigate } = useRouter();
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
  return <AgentDeploymentGuide session={session} onBack={() => navigate('/dashboard')} />;
}

function DashboardView({ session }: { session: AuthSession }): React.JSX.Element {
  const { navigate } = useRouter();
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

      {/* 4. Central Glow SVG */}
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

      <div className="dashboard-layout">
      {/* Header Section */}
      <header className="layout-header dashboard-header" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
          <div className="header-brand" style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
            <h1 className="logo-v2" style={{ fontSize: '1.4rem', cursor: 'default', margin: 0 }}>GB GHOSTBROKER</h1>
            <div className="observatory-badge">
              <span className="badge-dot"></span>
              OBSERVATORY MODE
            </div>
          </div>
          <div className="header-meta" style={{ display: 'flex', gap: 'var(--spacing-md)', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
              DID: {session.institution.t3TenantDid}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigate('/deploy')}
              style={{ fontSize: '0.7rem', padding: '4px 10px', fontFamily: 'var(--font-mono)' }}
            >
              🚀 Deploy Agent
            </button>
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

      {/* Connection Status Section (Metrics Grid) */}
      <div className="layout-metrics">
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

      {/* System Error Notification Banner */}
      {errorAlert && (
        <div 
          className="layout-header status-badge error" 
          style={{ 
            gridColumn: '1 / -1', 
            borderRadius: 'var(--radius-md)', 
            padding: 'var(--spacing-md)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            width: '100%',
            justifyContent: 'flex-start',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--spacing-sm)'
          }}
        >
          <AlertCircleIcon size={16} /> {errorAlert}
        </div>
      )}

      {/* Column 1: Institution Portfolio & Balance History */}
      <main className="layout-col-1" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
        <PortfolioCard
          institutionId={session.institution.id}
          token={session.token}
        />
        <PortfolioHistory
          institutionId={session.institution.id}
          token={session.token}
        />
      </main>

      {/* Column 2: Live Telemetry Activity Feed */}
      <section className="layout-col-2" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <LiveAgentActivityStream
            agents={agents}
            intents={intents}
            institutionName={session.institution.displayName}
            institutionDid={session.institution.t3TenantDid}
          />
        </div>
      </section>

      {/* Column 3: Decrypted Intent processing & Active sessions */}
      <section className="layout-col-3" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
        <div className="card">
          <ProcessingStatusRail intents={intents} />
        </div>
        <div className="card">
          <AgentConnectionGrid agents={agents} />
        </div>
      </section>

      {/* Bottom Section: Completed Trades & Audit History */}
      <footer className="layout-bottom card">
        <h2 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ScrollIcon size={18} style={{ color: 'var(--color-accent)' }} /> Completed Trades & Audit History
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
      
      <Route path="/deploy" element={
        session ? <AgentDeployView session={session} /> : null
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


