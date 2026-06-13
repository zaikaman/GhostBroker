import React, { useCallback, useState } from 'react';
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
  ScrollIcon,
} from 'hugeicons-react';

const DEFAULT_API_BASE_URL = 'http://localhost:3001';
const DEFAULT_TELEMETRY_WS_URL = 'ws://localhost:3001/ws/telemetry';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '');
const TELEMETRY_WS_URL = (import.meta.env.VITE_WS_TELEMETRY_URL || DEFAULT_TELEMETRY_WS_URL).replace(/\/$/, '');

function buildAuthSample(): string {
  return String.raw`# Step 1: Request a challenge
curl -s ${API_BASE_URL}/api/auth/challenge \
  -H "Content-Type: application/json" \
  -d '{"did": "did:t3n:0xYourAgentAddress"}' | jq .

# Returns: { challengeId: "ch_...", challenge: "...", expiresAt: "..." }

# Step 2: Sign the challenge with your agent's private key
# (Use ethers or your wallet to produce the signature)

# Step 3: Verify and get session token
curl -s ${API_BASE_URL}/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{
    "did": "did:t3n:0xYourAgentAddress",
    "challengeId": "ch_...",
    "signature": "0x<your_signature>",
    "walletAddress": "0xYourAgentAddress"
  }' | jq .

# Returns: { token: "gb_session_...", institution: {...} }`;
}

function buildWriteAgentSample(institutionId: string): string {
  return String.raw`import { Wallet } from "ethers";

const GHOSTBROKER_API_BASE_URL = process.env.GHOSTBROKER_API_BASE_URL ?? "${API_BASE_URL}";
const GHOSTBROKER_TELEMETRY_URL = process.env.GHOSTBROKER_TELEMETRY_URL ?? "${TELEMETRY_WS_URL}";
const INSTITUTION_ID = process.env.GHOSTBROKER_INSTITUTION_ID ?? "${institutionId}";
const AGENT_DID = process.env.AGENT_DID ?? "did:t3n:0xYourAgentAddress";
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY ?? "";
const AGENT_AUTHORITY_PROOF = process.env.GHOSTBROKER_AUTHORITY_PROOF ?? "";

const agent = new Wallet(AGENT_KEY);

async function authenticate() {
  const challengeResponse = await fetch(
    GHOSTBROKER_API_BASE_URL + "/api/auth/challenge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: AGENT_DID }),
    }
  ).then((response) => response.json());

  const signature = await agent.signMessage(challengeResponse.challenge);

  const verifyResponse = await fetch(
    GHOSTBROKER_API_BASE_URL + "/api/auth/verify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: AGENT_DID,
        challengeId: challengeResponse.challengeId,
        signature,
        walletAddress: agent.address,
      }),
    }
  ).then((response) => response.json());

  return verifyResponse.token as string;
}

async function admitAgent(token: string) {
  const admission = await fetch(GHOSTBROKER_API_BASE_URL + "/api/agents/admit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      institutionId: INSTITUTION_ID,
      agentDid: AGENT_DID,
      authorityProof: AGENT_AUTHORITY_PROOF,
    }),
  }).then((response) => response.json());

  return admission.authorityRef as string;
}

function listen(institutionId: string) {
  const ws = new WebSocket(
    GHOSTBROKER_TELEMETRY_URL + "?institutionId=" + encodeURIComponent(institutionId)
  );

  ws.onmessage = (event) => {
    const telemetry = JSON.parse(event.data);
    if (
      telemetry.type === "telemetry.processing.changed" &&
      telemetry.phase === "settlement_finalized"
    ) {
      console.log("[SETTLEMENT] Trade settled!", telemetry.correlationRef);
    }
  };
}

async function submitIntent(
  token: string,
  authorityRef: string,
  encryptedIntentEnvelope: string,
) {
  const response = await fetch(GHOSTBROKER_API_BASE_URL + "/api/agents/intents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      institutionId: INSTITUTION_ID,
      agentDid: AGENT_DID,
      encryptedIntentEnvelope,
      authorityRef,
    }),
  });

  return response.json();
}

async function main() {
  console.log("[AUTH] Authenticating...");
  const token = await authenticate();

  console.log("[ADMIT] Admitting agent...");
  const authorityRef = await admitAgent(token);

  listen(INSTITUTION_ID);

  console.log("[AGENT] Agent ready - waiting for matches...", authorityRef);
}

main().catch(console.error);`;
}

function buildDockerfileSample(): string {
  return String.raw`FROM node:20-alpine AS builder
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

CMD ["node", "dist/agent.js"]`;
}

function buildDockerComposeSample(institutionId: string): string {
  return `version: "3.9"
services:
  trading-agent:
    build: .
    container_name: ghostbroker-agent
    restart: unless-stopped
    environment:
      - GHOSTBROKER_API_BASE_URL=${API_BASE_URL}
      - GHOSTBROKER_TELEMETRY_URL=${TELEMETRY_WS_URL}
      - GHOSTBROKER_INSTITUTION_ID=${institutionId}
      - AGENT_DID=did:t3n:0xYourAgentAddress
      - AGENT_PRIVATE_KEY=${'${AGENT_PRIVATE_KEY}'}  # Set in .env
      - GHOSTBROKER_AUTHORITY_PROOF=${'${GHOSTBROKER_AUTHORITY_PROOF}'}  # Set in a secrets manager or .env
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"`;
}

function buildDeploySample(): string {
  return String.raw`# Create .env with your secrets
echo "AGENT_PRIVATE_KEY=0x..." > .env

# Build and run
docker compose up -d

# Check logs
docker compose logs -f trading-agent`;
}

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

const getStepIcon = (id: Step, size = 16): React.JSX.Element => {
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
    default:
      return <EyeIcon size={size} />;
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

function StepIndicator({ currentStep, onStepSelect }: { currentStep: Step; onStepSelect: (step: Step) => void }): React.JSX.Element {
  const currentIndex = STEPS.findIndex((step) => step.id === currentStep);

  return (
    <div className="deploy-steps-indicator">
      {STEPS.map((step, index) => {
        const isActive = step.id === currentStep;
        const isCompleted = index < currentIndex;

        return (
          <button
            key={step.id}
            type="button"
            className={`deploy-step-tab ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
            onClick={() => onStepSelect(step.id)}
            aria-current={isActive ? 'step' : undefined}
          >
            <div className="deploy-step-tab-content">
              <div className="deploy-step-tab-icon">
                {isCompleted ? <CheckmarkCircle01Icon size={14} /> : getStepIcon(step.id, 14)}
              </div>
              <div className="deploy-step-tab-info">
                <span className="deploy-step-tab-num">0{index + 1}</span>
                <span className="deploy-step-tab-label">{step.label}</span>
              </div>
            </div>
            <div className="deploy-step-tab-indicator-bar" />
          </button>
        );
      })}
    </div>
  );
}

function OverviewStep(): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Deploy Your Agent to GhostBroker</h2>
      <p className="deploy-step-desc">
        GhostBroker runs on an <strong>Agent-to-Agent (A2A)</strong> model. Humans do not place orders, match trades, or settle positions - autonomous agents do, inside cryptographically verified hardware enclaves.
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
          <div className="deploy-arch-desc">Watch-only dashboard for status and history</div>
        </div>
      </div>

      <div className="deploy-info-card">
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <LockIcon size={16} style={{ color: 'var(--color-accent)' }} /> What Your Agent Can Do
        </div>
        <ul className="deploy-info-list no-bullet">
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
            <span>Authenticate with the DID challenge-response flow</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
            <span>Submit encrypted trading intents with an authority reference</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
            <span>Listen for settlement events via secure WebSocket telemetry</span>
          </li>
          <li style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CancelCircleIcon size={14} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
            <span>Cannot see other institutions' intents or positions</span>
          </li>
        </ul>
      </div>

      <p className="deploy-step-cta-text">Follow the steps below to connect your agent. The whole flow takes about 15 minutes.</p>
    </div>
  );
}

function CredentialsStep({ session }: { session: AuthSession }): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Your GhostBroker Credentials</h2>
      <p className="deploy-step-desc">
        Copy these runtime values into your agent config. In production the dashboard origin is not the API origin, so use the backend and telemetry URLs shown here.
      </p>

      <div className="deploy-info-card">
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ClipboardIcon size={16} style={{ color: 'var(--color-accent)' }} /> Platform Values
        </div>
        <div className="deploy-credentials" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', marginTop: 'var(--spacing-md)' }}>
          <CopyField label="API Base URL" value={API_BASE_URL} />
          <CopyField label="Telemetry WebSocket URL" value={TELEMETRY_WS_URL} />
          <CopyField label="Institution DID" value={session.institution.t3TenantDid} />
          <CopyField label="Institution ID" value={session.institution.id} />
        </div>
      </div>

      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-md)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Wrench01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Required Tools
        </div>
        <ul className="deploy-info-list">
          <li><strong>Node.js 20+</strong> - Runtime for the agent</li>
          <li><strong>Docker</strong> - Recommended for production deployment</li>
          <li><strong>An Ethereum wallet or private key</strong> - Signs the DID challenge for the agent</li>
        </ul>
      </div>

      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-md)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Link01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Testnet Faucets
        </div>
        <p style={{ marginTop: 'var(--spacing-xs)', fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
          Your agent needs Sepolia testnet assets to pay gas fees and execute trades.
        </p>
        <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginTop: 'var(--spacing-md)', flexWrap: 'wrap' }}>
          <a
            href="https://cloud.google.com/application/web3/faucet/ethereum/sepolia"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
            style={{ 
              fontSize: '0.7rem', 
              padding: '6px 12px', 
              fontFamily: 'var(--font-mono)', 
              display: 'inline-flex', 
              alignItems: 'center', 
              gap: '4px',
              textDecoration: 'none'
            }}
          >
            <span>Get Sepolia ETH</span> ↗
          </a>
          <a
            href="https://gho.aave.com/faucet"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
            style={{ 
              fontSize: '0.7rem', 
              padding: '6px 12px', 
              fontFamily: 'var(--font-mono)', 
              display: 'inline-flex', 
              alignItems: 'center', 
              gap: '4px',
              textDecoration: 'none'
            }}
          >
            <span>Get WBTC & USDC</span> ↗
          </a>
        </div>
      </div>

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Key01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Generate an Agent Key:
        </strong> Run this locally to create a new keypair for your agent:
        <CodeBlock code="npx -y ethers@6 wallet create" />
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
          Save the private key. The corresponding address becomes the DID subject the agent presents to GhostBroker.
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
        Every agent must authenticate using GhostBroker's <strong>DID Challenge-Response</strong> protocol before it can submit intents or receive settlement events.
      </p>

      <div className="deploy-flow-diagram">
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">1</div>
          <div className="deploy-flow-body">
            <strong>Request Challenge</strong>
            <span>Agent sends its DID to <code>{API_BASE_URL}/api/auth/challenge</code></span>
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
            <span>Agent submits the signed challenge and wallet address to <code>{API_BASE_URL}/api/auth/verify</code></span>
          </div>
        </div>
        <div className="deploy-flow-arrow">↓</div>
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">4</div>
          <div className="deploy-flow-body">
            <strong>Admit Agent</strong>
            <span>Use the session token to admit the agent and capture an authority reference</span>
          </div>
        </div>
        <div className="deploy-flow-arrow">↓</div>
        <div className="deploy-flow-step">
          <div className="deploy-flow-num">5</div>
          <div className="deploy-flow-body">
            <strong>Trade Ready</strong>
            <span>Agent can submit encrypted intents and receive settlement events</span>
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Settings01Icon size={16} /> Quick Test with curl
      </h3>
      <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-md)' }}>
        Replace the DID, signature, and wallet address with the values from the wallet that controls the agent.
      </p>

      <CodeBlock code={buildAuthSample()} />

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Idea01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Tip:
        </strong> Store the session token and include it as a Bearer token in subsequent REST calls.
      </div>
    </div>
  );
}

function WriteAgentStep({ session }: { session: AuthSession }): React.JSX.Element {
  const agentSample = buildWriteAgentSample(session.institution.id);

  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Write Your Agent</h2>
      <p className="deploy-step-desc">
        This bootstrap matches the current REST and WebSocket contracts. Replace the placeholders with your wallet key, DID, and delegation proof payload.
      </p>

      <div className="deploy-tip-box" style={{ marginBottom: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Package01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Dependencies:
        </strong> You need <code>ethers</code> for signing and a delegation proof payload for agent admission.
        <CodeBlock code="npm install ethers" />
      </div>

      <CodeBlock code={agentSample} />

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Settings01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Customize:
        </strong> Replace the <code>AGENT_KEY</code>, <code>AGENT_DID</code>, and <code>AGENT_AUTHORITY_PROOF</code> values with your deployment secrets, then run:
        <CodeBlock code="npm install ethers && npx tsx agent.ts" />
      </div>
    </div>
  );
}

function DockerDeployStep({ session }: { session: AuthSession }): React.JSX.Element {
  const dockerComposeSample = buildDockerComposeSample(session.institution.id);

  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Docker Deployment</h2>
      <p className="deploy-step-desc">
        For production, wrap your agent in a Docker container and deploy it to your infrastructure. Keep secrets in runtime env vars or a secrets manager; do not bake them into the image.
      </p>

      <h3 style={{ marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        1. Dockerfile
      </h3>
      <CodeBlock code={buildDockerfileSample()} language="dockerfile" />

      <h3 style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        2. docker-compose.yml
      </h3>
      <CodeBlock code={dockerComposeSample} />

      <h3 style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        3. Deploy
      </h3>
      <CodeBlock code={buildDeploySample()} />

      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-lg)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <CloudIcon size={16} style={{ color: 'var(--color-accent)' }} /> Deployment Options
        </div>
        <ul className="deploy-info-list">
          <li><strong>Your own VM</strong> - Any cloud provider (AWS EC2, GCP Compute, Azure VM, DigitalOcean)</li>
          <li><strong>Kubernetes</strong> - Deploy as a Deployment with secrets for private keys</li>
          <li><strong>Serverless</strong> - Not recommended; agents need persistent WebSocket connections</li>
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

function MonitorStep({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <h2 className="deploy-step-title">Monitor Your Agent</h2>
      <p className="deploy-step-desc">
        Once deployed, your agent appears in the <strong>Observatory Console</strong>. The telemetry stream is filtered by institution ID and never requires a client-side subscribe message.
      </p>

      <div className="deploy-monitor-grid">
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon">
            <Plug01Icon size={24} style={{ color: 'var(--color-success)' }} />
          </div>
          <div className="deploy-monitor-title">Connection Status</div>
          <div className="deploy-monitor-desc">
            Real-time telemetry link indicator. Open the socket with the institutionId query parameter.
          </div>
        </div>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon">
            <Chart01Icon size={24} style={{ color: 'var(--color-accent)' }} />
          </div>
          <div className="deploy-monitor-title">Activity Feed</div>
          <div className="deploy-monitor-desc">
            Live stream of agent events: authentication, admission, intent sealing, settlement finalization, and receipt availability.
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
            <span>Intervene in active trades - the enclave is autonomous</span>
          </li>
        </ul>
      </div>

      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)', textAlign: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Idea01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Open telemetry with <code>{TELEMETRY_WS_URL}?institutionId=&lt;uuid&gt;</code>. The server filters by institution ID and ignores client-side subscribe messages.
        </span>
      </div>

      <div style={{ marginTop: 'var(--spacing-lg)', textAlign: 'center', padding: 'var(--spacing-lg)' }}>
        <p style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <CheckmarkCircle01Icon size={14} style={{ color: 'var(--color-success)' }} /> Your agent is now part of the GhostBroker dark pool. All matching and settlement happens automatically inside the secure enclave.
        </p>
        <button type="button" className="btn btn-primary" onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
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

  const stepIndex = STEPS.findIndex((step) => step.id === currentStep);

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
      case 'overview':
        return <OverviewStep />;
      case 'credentials':
        return <CredentialsStep session={session} />;
      case 'authenticate':
        return <AuthenticateStep />;
      case 'write-agent':
        return <WriteAgentStep session={session} />;
      case 'docker-deploy':
        return <DockerDeployStep session={session} />;
      case 'monitor':
        return <MonitorStep onBack={onBack} />;
      default:
        return <OverviewStep />;
    }
  };

  return (
    <div className="deploy-layout">
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

      <StepIndicator currentStep={currentStep} onStepSelect={setCurrentStep} />

      <div className="deploy-content">
        {renderStep()}
      </div>

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