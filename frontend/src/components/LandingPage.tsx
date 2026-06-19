import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { ArrowRight, Menu, X } from 'lucide-react';
import { LockIcon } from 'hugeicons-react';
import '../styles/landing-v2.css';

interface LandingPageProps {
  onLaunch: () => void;
}

export function LandingPage({ onLaunch }: LandingPageProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

  // HLS Video streaming setup
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
          console.warn('Auto-play failed/prevented:', err);
        });
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native Safari/iOS support
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

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  const handleNavClick = (anchorId: string) => {
    setIsMobileMenuOpen(false);
    const target = document.getElementById(anchorId);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="landing-v2-container">
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

      {/* 3. Outer HUD Framework */}
      <div className="hud-console-frame" aria-hidden="true">
        <div className="console-corner console-corner-tl" />
        <div className="console-corner console-corner-tr" />
        <div className="console-corner console-corner-bl" />
        <div className="console-corner console-corner-br" />
      </div>

      {/* 4. Global Navigation Header */}
      <header className="header-v2">
        <div className="logo-v2" onClick={() => handleNavClick('hero-top')}>
          <span>GhostBroker</span>
          <span className="logo-dot" />
        </div>

        {/* Center Live Badge */}
        {/* <div className="hud-status-bar-center">
          <div className="status-badge-item">
            <span className="pulse-dot green" />
            <span className="status-label-text">TEE STATE: ACTIVE</span>
          </div>
          <div className="status-badge-separator" />
          <div className="status-badge-item">
            <span className="pulse-dot green" />
            <span className="status-label-text">NETWORK: T3 TESTNET</span>
          </div>
        </div> */}

        {/* Desktop Menu */}
        <nav className="nav-menu-desktop" aria-label="Desktop Navigation">
          <a
            href="https://docs.terminal3.io"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link-v2"
          >
            TEE Sandbox
          </a>
          <button type="button" className="btn-nav-primary" onClick={onLaunch}>
            Enter Observatory
          </button>
        </nav>

        {/* Hamburger Menu Toggle Button */}
        <button
          type="button"
          className="hamburger-btn"
          onClick={toggleMobileMenu}
          aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={isMobileMenuOpen}
        >
          {isMobileMenuOpen ? <X size={28} /> : <Menu size={28} />}
        </button>
      </header>

      {/* Mobile Menu Overlay */}
      <div className={`mobile-menu-overlay ${isMobileMenuOpen ? 'active' : ''}`} aria-hidden={!isMobileMenuOpen}>
        <a
          href="https://docs.terminal3.io"
          target="_blank"
          rel="noopener noreferrer"
          className="mobile-nav-link"
          onClick={() => setIsMobileMenuOpen(false)}
        >
          TEE Sandbox
        </a>
        <button
          type="button"
          className="btn-nav-primary"
          onClick={() => {
            setIsMobileMenuOpen(false);
            onLaunch();
          }}
          style={{ marginTop: '1.5rem', width: '200px' }}
        >
          Enter Observatory
        </button>
      </div>

      {/* 5. Main Hero Section */}
      <main className="hero-v2-section" id="hero-top">
        <div className="hero-v2-grid">
          <div className="hero-v2-content-wrapper">
            <div className="system-tag-badge">
              <LockIcon size={12} className="tag-icon" />
              <span>ZERO-HUMAN VISIBILITY ATTESTED</span>
            </div>

            <h1 className="hero-v2-headline">
              Autonomous<br />
              Liquidity.<br />
              <span className="italic-display">Sealed in Silicon</span>
              <span className="headline-dot">.</span>
            </h1>

            <p className="hero-v2-description">
              Deploy autonomous verified agents to execute large block trades securely inside hardware enclaves, 
              completely hidden from public orderbooks and human operators to eliminate front-running and slippage.
            </p>

            <div className="hero-v2-cta-container">
              <button type="button" className="btn-v2-primary" onClick={onLaunch}>
                Enter Observatory Console <ArrowRight size={18} />
              </button>
              <button
                type="button"
                className="btn-v2-secondary"
                onClick={onLaunch}
              >
                Launch Console
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

