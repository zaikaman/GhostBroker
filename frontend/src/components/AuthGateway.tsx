import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { connectWithWallet } from '../services/wallet-auth';
import type { AuthSession } from '../services/api-client';
import { Wallet } from 'lucide-react';
import '../styles/landing-v2.css';

interface AuthGatewayProps {
  onAuthenticated: (session: AuthSession) => void;
}

export function AuthGateway({ onAuthenticated }: AuthGatewayProps): React.JSX.Element {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const streamUrl = 'https://stream.mux.com/tLkHO1qZoaaQOUeVWo8hEBeGQfySP02EPS02BmnNFyXys.m3u8';
    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: false // Enforce stability in sandboxed environments as per spec
      });
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch((err) => {
          console.warn('Auth view video auto-play failed:', err);
        });
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      video.addEventListener('loadedmetadata', () => {
        video.play().catch((err) => {
          console.warn('Auth view video native auto-play failed:', err);
        });
      });
    }

    return () => {
      if (hls) {
        hls.destroy();
      }
    };
  }, []);

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
    <main className="auth-v2-container">
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
          opacity="0.3"
        />
        <linearGradient id="glowGradient" x1="150" y1="100" x2="850" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00f2fe" />
          <stop offset="50%" stopColor="#5ed29c" />
          <stop offset="100%" stopColor="#0575e6" />
        </linearGradient>
      </svg>

      {/* 5. Liquid Glass Card Panel */}
      <section className="auth-v2-card" aria-labelledby="auth-title">
        {/* Logo matching the header */}
        <div className="auth-v2-logo">
          <span>GB</span>
          <span style={{ fontSize: '1.25rem', letterSpacing: '0.05em', opacity: 0.9 }}>GhostBroker</span>
        </div>

        <p className="auth-v2-eyebrow">Terminal 3 Enclave Security</p>
        
        <h1 id="auth-title" className="auth-v2-title">
          Operator Console<span className="auth-v2-title-dot">.</span>
        </h1>

        <p className="auth-v2-description">
          To access the autonomous trading zone, authenticate using your Web3 wallet. 
          A cryptographic hardware challenge will be issued to authorize session credentials inside the secure TEE.
        </p>

        <button
          type="button"
          className="auth-v2-button"
          onClick={handleWalletConnect}
          disabled={isSubmitting}
        >
          <Wallet size={18} />
          {isSubmitting ? 'Verifying Challenge...' : 'Connect Web3 Wallet'}
        </button>

        {error && (
          <div className="auth-v2-error" role="alert">
            {error}
          </div>
        )}
      </section>
    </main>
  );
}
