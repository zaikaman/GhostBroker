import React, { useState, useCallback } from 'react';
import { type AuthSession } from '../services/api-client';
import {
  EyeIcon,
  Key01Icon,
  LockKeyIcon,
  CodeIcon,
  Package01Icon,
  Chart01Icon,
  BankIcon,
  Shield01Icon,
  LockIcon,
  CheckmarkCircle01Icon,
  CancelCircleIcon,
  ClipboardIcon,
  Wrench01Icon,
  Idea01Icon,
  Settings01Icon,
  CloudIcon,
  AlertCircleIcon,
  Plug01Icon,
  Link01Icon,
  ScrollIcon
} from 'hugeicons-react';

interface AgentDeploymentGuideProps {
  session: AuthSession;
  onBack: () => void;
}

type Step = 'overview' | 'credentials' | 'authenticate' | 'write-agent' | 'docker-deploy' | 'monitor';

const STEPS: { id: Step; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'authenticate', label: 'Authenticate' },
  { id: 'write-agent', label: 'Write Agent' },
  { id: 'docker-deploy', label: 'Deploy' },
  { id: 'monitor', label: 'Monitor' },
];

const getStepIcon = (id: Step, size = 16) => {
  switch (id) {
    case 'overview':
      return <EyeIcon size={size} />;
    case 'credentials':
      return <Key01Icon size={size} />;
    case 'authenticate':
      return <LockKeyIcon size={size} />;
    case 'write-agent':
      return <CodeIcon size={size} />;
    case 'docker-deploy':
      return <Package01Icon size={size} />;
    case 'monitor':
      return <Chart01Icon size={size} />;
  }
};

function CodeBlock({ code, language = 'bash' }: { code: string; language?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="deploy-code-block">
      <div className="deploy-code-header">
        <span className="deploy-code-lang">{language}</span>
        <button type="button" className="deploy-code-copy-btn" onClick={handleCopy} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          {copied ? (
            <>
              <CheckmarkCircle01Icon size={12} style={{ color: 'var(--color-success)' }} /> Copied
            </>
          ) : (
            <>
              <ClipboardIcon size={12} /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="deploy-code-body"><code>{code}</code></pre>
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [value]);

  return (
    <div className="deploy-copy-field">
      <span className="deploy-copy-label">{label}</span>
      <div className="deploy-copy-value-row">
        <code className="deploy-copy-value">{value}</code>
        <button type="button" className="deploy-code-copy-btn" onClick={handleCopy} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {copied ? <CheckmarkCircle01Icon size={12} style={{ color: 'var(--color-success)' }} /> : <ClipboardIcon size={12} />}
        </button>
      </div>
    </div>
  );
}

function StepIndicator({ currentStep }: { currentStep: Step }): React.JSX.Element {
  const currentIndex = STEPS.findIndex(s => s.id === currentStep);

  return (
    <div className="deploy-steps-indicator">
      {STEPS.map((step, i) => (
        <div
          key={step.id}
          className={`deploy-step-dot ${i === currentIndex ? 'active' : ''} ${i < currentIndex ? 'completed' : ''}`}
        >
          <div className="deploy-step-circle">
            {i < currentIndex ? <CheckmarkCircle01Icon size={14} /> : getStepIcon(step.id, 14)}
          </div>
          <span className="deploy-step-label">{step.label}</span>
          {i < STEPS.length - 1 && <div className={`deploy-step-line ${i < currentIndex ? 'filled' : ''}`} />}
        </div>
      ))}
    </div>
  );
}

function OverviewStep(): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Deploy Your Agent to GhostBroker</h2>
      <p className="deploy-step-desc">
        GhostBroker runs on an <strong>Agent-to-Agent (A2A)</strong> model. Humans do not place orders, 
        match trades, or settle positions — autonomous agents do, inside cryptographically verified 
        hardware enclaves. Your role as an institution is to <strong>deploy an agent</strong> that represents 
        your trading strategy.
      </p>

      <div className="deploy-arch-diagram">
        <div className="deploy-arch-node">
          <div className="deploy-arch-icon">
            <BankIcon size={24} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="deploy-arch-title">Your Institution</div>
          <div className="deploy-arch-desc">Runs an autonomous agent in your own infrastructure</div>
        </div>
        <div className="deploy-arch-arrow">↔</div>
        <div className="deploy-arch-node">
          <div className="deploy-arch-icon">
            <Shield01Icon size={24} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="deploy-arch-title">GhostBroker Platform</div>
          <div className="deploy-arch-desc">Secure enclave-based matching & settlement</div>
        </div>
        <div className="deploy-arch-arrow">↔</div>
        <div className="deploy-arch-node">
          <div className="deploy-arch-icon">
            <Chart01Icon size={24} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="deploy-arch-title">Observatory Console</div>
          <div className="deploy-arch-desc">Your dashboard — watch-only, no intervention</div>
        </div>
      </div>

      <div className="deploy-info-card">
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <LockIcon size={16} style={{ color: 'var(--color-accent)' }} /> What Your Agent Can Do
        </div>
        <ul className="deploy-info-list no-bullet">
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
            <span>Authenticate using your institution's GhostBroker credentials</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
            <span>Submit encrypted trading intents (price, volume, direction)</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
            <span>Listen for match settlement events via secure WebSocket</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
            <span>Retrieve encrypted audit receipts for settled trades</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>Cannot view other institutions' intents or positions</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>No human override — once deployed, the agent operates autonomously</span>
          </li>
        </ul>
      </div>

      <p className="deploy-step-cta-text">
        Follow the steps below to get your agent connected. The entire process takes about 15 minutes.
      </p>
    </div>
  );
}

function CredentialsStep({ session }: { session: AuthSession }): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Your GhostBroker Credentials</h2>
      <p className="deploy-step-desc">
        Your institution is already registered on GhostBroker. These are the credentials your agent will use to 
        authenticate. No external setup needed — just copy these values into your agent's configuration.
      </p>

      <div className="deploy-info-card">
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ClipboardIcon size={16} style={{ color: 'var(--color-accent)' }} /> Your Platform Credentials
        </div>
        <div className="deploy-credentials" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', marginTop: 'var(--spacing-md)' }}>
          <CopyField label="API Base URL" value={window.location.origin} />
          <CopyField label="Your DID" value={session.institution.t3TenantDid} />
          <CopyField label="Institution ID" value={session.institution.id} />
        </div>
      </div>

      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-md)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Wrench01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Required Tools
        </div>
        <ul className="deploy-info-list">
          <li><strong>Node.js 20+</strong> — Runtime for the agent (or any language that speaks HTTP/WebSocket)</li>
          <li><strong>Docker</strong> — Recommended for production deployment</li>
          <li><strong>An Ethereum wallet or private key</strong> — To sign authentication challenges. Generate one with <code>ethers</code> or use your existing key.</li>
        </ul>
      </div>

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Key01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Generate an Agent Key:
        </strong> Run this locally to create a new keypair for your agent:
        <CodeBlock code="npx -y ethers@6 wallet create" />
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
          Save the private key — it will be used to sign authentication challenges. The corresponding 
          address will be your agent's identity on GhostBroker.
        </span>
      </div>
    </div>
  );
}

function AuthenticateStep(): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Agent Authentication Flow</h2>
      <p className="deploy-step-desc">
        Every agent must authenticate using GhostBroker's <strong>DID Challenge-Response</strong> protocol 
        before it can submit intents or receive settlement events. Your agent proves its identity by signing 
        a cryptographic challenge with its private key.
      </p>

      <div className="deploy-flow-diagram">
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">1</div>
          <div className="deploy-flow-body">
            <strong>Request Challenge</strong>
            <span>Agent sends its DID to <code>POST /api/auth/challenge</code></span>
          </div>
        </div>
        <div className="deploy-flow-arrow">↓</div>
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">2</div>
          <div className="deploy-flow-body">
            <strong>Sign Challenge</strong>
            <span>Agent signs the challenge using its private key (EIP-191 / secp256k1)</span>
          </div>
        </div>
        <div className="deploy-flow-arrow">↓</div>
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">3</div>
          <div className="deploy-flow-body">
            <strong>Verify & Get Session</strong>
            <span>Agent submits signed challenge to <code>POST /api/auth/verify</code></span>
          </div>
        </div>
        <div className="deploy-flow-arrow">↓</div>
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">4</div>
          <div className="deploy-flow-body">
            <strong>Admit Agent</strong>
            <span>Agent is registered and ready to trade</span>
          </div>
        </div>
        <div className="deploy-flow-arrow">↓</div>
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">5</div>
          <div className="deploy-flow-body">
            <strong>Trade Ready</strong>
            <span>Agent can submit intents and receive settlement events</span>
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Settings01Icon size={16} /> Quick Test with curl
      </h3>
      <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-md)' }}>
        Replace <code>YOUR_DID</code> and <code>YOUR_SIGNATURE</code> with your actual values.
      </p>

      <CodeBlock code={`# Step 1: Request a challenge
curl -s ${window.location.origin}/api/auth/challenge \\
  -H "Content-Type: application/json" \\
  -d '{"did": "did:t3n:your-institution-did"}' | jq .

# Returns: { challengeId: "ch_...", challenge: "...", expiresAt: "..." }

# Step 2: Sign the challenge with your agent's private key
# (Use ethers or your wallet to produce the signature)

# Step 3: Verify and get session token
curl -s ${window.location.origin}/api/auth/verify \\
  -H "Content-Type: application/json" \\
  -d '{
    "did": "did:t3n:your-institution-did",
    "challengeId": "ch_...",
    "signature": "0x<your_signature>"
  }' | jq .

# Returns: { token: "gb_session_...", institution: {...} }`} />

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Idea01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Tip:
        </strong> Your agent should store the session token and include it as a Bearer token 
        in all subsequent requests: <code>Authorization: Bearer gb_session_...</code>
      </div>
    </div>
  );
}

function WriteAgentStep({ session }: { session: AuthSession }): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Write Your Agent</h2>
      <p className="deploy-step-desc">
        Here's a complete, production-ready agent script. Copy this into a file called <code>agent.ts</code> 
        and customize the parameters to your strategy.
      </p>

      <div className="deploy-tip-box" style={{ marginBottom: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Package01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Dependencies:
        </strong> You only need <code>ethers</code> for cryptographic signing:
        <CodeBlock code="npm install ethers" />
        The GhostBroker API is plain HTTP + WebSocket — no SDK required.
      </div>

      <CodeBlock code={`import { Wallet } from "ethers";

// [CONFIG] Configuration
const GHOSTBROKER_URL = "${window.location.origin}";
const AGENT_DID = "${session.institution.t3TenantDid}";
const AGENT_KEY = "0x...";  // Store securely in env vars / secrets manager

const agent = new Wallet(AGENT_KEY);

// [AUTH] Authenticate with DID Challenge-Response
async function authenticate() {
  // 1. Request a cryptographic challenge
  const { challengeId, challenge } = await fetch(
    \`\${GHOSTBROKER_URL}/api/auth/challenge\`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: AGENT_DID }) }
  ).then(r => r.json());

  // 2. Sign the challenge with your agent's private key
  const signature = await agent.signMessage(challenge);

  // 3. Verify signature and get session token
  const { token } = await fetch(
    \`\${GHOSTBROKER_URL}/api/auth/verify\`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: AGENT_DID,
        challengeId,
        signature,
        walletAddress: agent.address,
      }) }
  ).then(r => r.json());

  return token;
}

// [TELEMETRY] Listen for Settlement Events
function listen(token: string) {
  const ws = new WebSocket(
    \`\${GHOSTBROKER_URL.replace("http", "ws")}/ws/telemetry\`
  );

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "subscribe", sessionToken: token }));
    console.log("[TELEMETRY] Connected to telemetry stream");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "settlement_executed") {
      console.log("[SETTLEMENT] Trade settled!", msg);
    }
  };
}

// [INTENT] Submit an Encrypted Intent
async function submitIntent(token: string, encrypted: object) {
  const res = await fetch(\`\${GHOSTBROKER_URL}/api/agents/intents\`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${token}\`,
    },
    body: JSON.stringify({
      agentId: AGENT_DID,
      encryptedPayload: encrypted,
    }),
  });
  return res.json();
}

// [RUN] Run
async function main() {
  console.log("[AUTH] Authenticating...");
  const token = await authenticate();
  console.log("[AUTH] Authenticated — session acquired");

  listen(token);

  console.log("[AGENT] Agent ready — waiting for matches...");
}

main().catch(console.error);`} />

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Settings01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Customize:
        </strong> Replace the <code>AGENT_KEY</code> with your actual private key, then run:
        <CodeBlock code="npm install ethers && npx tsx agent.ts" />
      </div>
    </div>
  );
}

function DockerDeployStep({ session }: { session: AuthSession }): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Deploy with Docker</h2>
      <p className="deploy-step-desc">
        For production, wrap your agent in a Docker container and deploy it to your infrastructure.
      </p>

      <h3 style={{ marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        1. Dockerfile
      </h3>
      <CodeBlock code={`FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY agent.ts tsconfig.json ./
RUN npx tsc --outDir dist

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV GHOSTBROKER_BASE_URL="${window.location.origin}"
ENV AGENT_DID="${session.institution.t3TenantDid}"
ENV AGENT_PRIVATE_KEY=""

CMD ["node", "dist/agent.js"]`} language="dockerfile" />

      <h3 style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        2. docker-compose.yml
      </h3>
      <CodeBlock code={`version: "3.9"
services:
  trading-agent:
    build: .
    container_name: ghostbroker-agent
    restart: unless-stopped
    environment:
      - GHOSTBROKER_BASE_URL=${window.location.origin}
      - AGENT_DID=${session.institution.t3TenantDid}
      - AGENT_PRIVATE_KEY=${'${AGENT_PRIVATE_KEY}'}  # Set in .env
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"`} />

      <h3 style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        3. Deploy
      </h3>
      <CodeBlock code={`# Create .env with your secrets
echo "AGENT_PRIVATE_KEY=0x..." > .env

# Build and run
docker compose up -d

# Check logs
docker compose logs -f trading-agent`} />

      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-lg)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <CloudIcon size={16} style={{ color: 'var(--color-accent)' }} /> Deployment Options
        </div>
        <ul className="deploy-info-list">
          <li><strong>Your own VM</strong> — Any cloud provider (AWS EC2, GCP Compute, Azure VM, DigitalOcean)</li>
          <li><strong>Kubernetes</strong> — Deploy as a Deployment with secrets for private keys</li>
          <li><strong>Serverless</strong> — Not recommended; agents need persistent WebSocket connections</li>
        </ul>
        <p style={{ marginTop: 'var(--spacing-md)', fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <AlertCircleIcon size={14} style={{ color: 'var(--color-error)' }} />
          <span>
            <strong>Security:</strong> Never hardcode private keys. Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, or Docker secrets).
          </span>
        </p>
      </div>
    </div>
  );
}

function MonitorStep(): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Monitor Your Agent</h2>
      <p className="deploy-step-desc">
        Once deployed, your agent appears in the <strong>Observatory Console</strong>. Here's what you can see:
      </p>

      <div className="deploy-monitor-grid">
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon">
            <Plug01Icon size={24} style={{ color: 'var(--color-success)' }} />
          </div>
          <div className="deploy-monitor-title">Connection Status</div>
          <div className="deploy-monitor-desc">
            Real-time telemetry link indicator. Shows whether your agent's WebSocket connection is active.
          </div>
        </div>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon">
            <Chart01Icon size={24} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="deploy-monitor-title">Activity Feed</div>
          <div className="deploy-monitor-desc">
            Live stream of agent events: authentication, intent submission, settlement confirmations.
          </div>
        </div>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon">
            <Link01Icon size={24} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="deploy-monitor-title">Connected Agents</div>
          <div className="deploy-monitor-desc">
            Grid of all admitted agents for your institution with status badges.
          </div>
        </div>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon">
            <ScrollIcon size={24} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="deploy-monitor-title">Trade History</div>
          <div className="deploy-monitor-desc">
            Completed trades with encrypted audit receipts. Decrypt individual receipts for regulatory proof.
          </div>
        </div>
      </div>

      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-lg)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <CancelCircleIcon size={16} style={{ color: 'var(--color-error)' }} /> What You Cannot Do (By Design)
        </div>
        <ul className="deploy-info-list no-bullet">
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>View other institutions' intents, orders, or positions</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>Modify or cancel an agent's submitted intent</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>Access the sealed matching core or settlement logic</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>Decrypt receipts not belonging to your institution</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>Intervene in active trades — the enclave is autonomous</span>
          </li>
        </ul>
      </div>

      <div style={{ marginTop: 'var(--spacing-lg)', textAlign: 'center', padding: 'var(--spacing-lg)' }}>
        <p style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)' }} /> Your agent is now part of the GhostBroker dark pool. All matching and settlement happens automatically inside the secure enclave.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.hash = '#/dashboard'} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <EyeIcon size={14} /> Return to Observatory Console
        </button>
      </div>

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)', textAlign: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Idea01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Allow <strong>~30 seconds</strong> after deployment for the first heartbeat to appear on the dashboard.
        </span>
      </div>
    </div>
  );
}

export function AgentDeploymentGuide({ session, onBack }: AgentDeploymentGuideProps): React.JSX.Element {
  const [currentStep, setCurrentStep] = useState<Step>('overview');

  const stepIndex = STEPS.findIndex(s => s.id === currentStep);

  const goNext = () => {
    const nextIndex = stepIndex + 1;
    if (nextIndex < STEPS.length) {
      const nextStep = STEPS[nextIndex]!;
      setCurrentStep(nextStep.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const goPrev = () => {
    const prevIndex = stepIndex - 1;
    if (prevIndex >= 0) {
      const prevStep = STEPS[prevIndex]!;
      setCurrentStep(prevStep.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 'overview': return <OverviewStep />;
      case 'credentials': return <CredentialsStep session={session} />;
      case 'authenticate': return <AuthenticateStep />;
      case 'write-agent': return <WriteAgentStep session={session} />;
      case 'docker-deploy': return <DockerDeployStep session={session} />;
      case 'monitor': return <MonitorStep />;
    }
  };

  return (
    <div className="deploy-layout">
      {/* Header */}
      <header className="deploy-header">
        <div className="deploy-header-left">
          <button type="button" className="btn btn-secondary" onClick={onBack} style={{ fontSize: '0.75rem', padding: 'var(--spacing-xs) var(--spacing-md)' }}>
            ← Back to Dashboard
          </button>
        </div>
        <div className="deploy-header-center">
          <h1 className="deploy-title">Deploy Your Agent</h1>
          <span className="deploy-subtitle">Connect your autonomous trading agent to GhostBroker</span>
        </div>
        <div className="deploy-header-right">
          <div className="observatory-badge" style={{ fontSize: '0.6rem' }}>
            <span className="badge-dot" />
            {session.institution.t3TenantDid.slice(0, 24)}...
          </div>
        </div>
      </header>

      {/* Step Indicator */}
      <StepIndicator currentStep={currentStep} />

      {/* Step Content */}
      <div className="deploy-content">
        {renderStep()}
      </div>

      {/* Navigation */}
      <div className="deploy-nav">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={goPrev}
          disabled={stepIndex === 0}
          style={{ fontSize: '0.8rem', padding: 'var(--spacing-sm) var(--spacing-lg)' }}
        >
          ← Previous
        </button>
        <div className="deploy-nav-progress">
          Step {stepIndex + 1} of {STEPS.length}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={goNext}
          style={{ fontSize: '0.8rem', padding: 'var(--spacing-sm) var(--spacing-lg)' }}
        >
          {stepIndex === STEPS.length - 1 ? '✓ Complete' : 'Next →'}
        </button>
      </div>
    </div>
  );
}
