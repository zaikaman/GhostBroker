import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { ArrowRight, Menu, X } from 'lucide-react';
import '../styles/landing-v2.css';

interface LandingPageProps {
  onLaunch: () => void;
}

export function LandingPage({ onLaunch }: LandingPageProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);

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

      {/* 5. Global Navigation Header */}
      <header className="header-v2">
        <div className="logo-v2" onClick={() => handleNavClick('hero-top')}>
          <span>GB</span>
          <span style={{ fontSize: '1.25rem', letterSpacing: '0.05em', opacity: 0.9 }}>GhostBroker</span>
        </div>

        {/* Desktop Menu */}
        <nav className="nav-menu-desktop" aria-label="Desktop Navigation">
          <button type="button" onClick={() => handleNavClick('hero-top')} className="nav-link-v2">
            Protocol
          </button>
          <a
            href="https://docs.terminal3.io"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link-v2"
          >
            TEE Sandbox
          </a>
          <button type="button" onClick={() => handleNavClick('hero-top')} className="nav-link-v2">
            Security
          </button>
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
        <button type="button" onClick={() => handleNavClick('hero-top')} className="mobile-nav-link">
          Protocol
        </button>
        <a
          href="https://docs.terminal3.io"
          target="_blank"
          rel="noopener noreferrer"
          className="mobile-nav-link"
          onClick={() => setIsMobileMenuOpen(false)}
        >
          TEE Sandbox
        </a>
        <button type="button" onClick={() => handleNavClick('hero-top')} className="mobile-nav-link">
          Security
        </button>
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

      {/* 6. Main Hero Grid */}
      <main className="hero-v2-section" id="hero-top">
        <div className="hero-v2-grid">
          {/* Left Side: Headline and copy */}
          <div className="hero-v2-content-wrapper">
            {/* The Liquid Glass Card */}
            <div className="liquid-glass-card-wrapper">
              <div className="liquid-glass-card">
                <div className="liquid-glass-tag">[ GB-TEE ]</div>
                <h3 className="liquid-glass-headline">
                  TEE-Enforced <em>Agent</em> Execution
                </h3>
                <p className="liquid-glass-description">
                  Programmatic matching shielded from human eyes inside attested Intel SGX enclaves.
                </p>
              </div>
            </div>

            <span className="hero-v2-eyebrow">Zero-Knowledge Block Trading</span>
            <h1 className="hero-v2-headline">
              Autonomous Liquidity.<br />
              Sealed in Silicon<span className="hero-v2-headline-dot">.</span>
            </h1>
            <p className="hero-v2-description">
              Deploy autonomous verified agents to execute large block trades securely inside hardware enclaves, 
              completely hidden from the public and human operators to prevent market slippage.
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

          {/* Right Side: Empty to allow background video to be fully visible on right as in Image 3 */}
          <div className="hero-v2-visual-panel" aria-hidden="true" />
        </div>
      </main>
    </div>
  );
}
