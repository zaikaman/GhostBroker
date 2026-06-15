import React, { useCallback, useState } from 'react';
import { type AuthSession } from '../services/api-client';
import {
  EyeIcon,
  Key01Icon,
  CodeIcon,
  Package01Icon,
  Chart01Icon,
  Shield01Icon,
  CheckmarkCircle01Icon,
  ClipboardIcon,
  Plug01Icon,
  Link01Icon,
  ScrollIcon,
  Idea01Icon,
} from 'hugeicons-react';

const DEFAULT_API_BASE_URL = 'http://localhost:3001';
const DEFAULT_TELEMETRY_WS_URL = 'ws://localhost:3001/ws/telemetry';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '');
const TELEMETRY_WS_URL = (import.meta.env.VITE_WS_TELEMETRY_URL || DEFAULT_TELEMETRY_WS_URL).replace(/\/$/, '');

interface AgentDeploymentGuideProps {
  session: AuthSession;
  onBack: () => void;
}

type Section = 'configure' | 'deploy' | 'monitor';

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
          {copied ? <><CheckmarkCircle01Icon size={12} style={{ color: 'var(--color-success)' }} /> Copied</> : <><ClipboardIcon size={12} /> Copy</>}
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

function ConfigureSection({ session }: { session: AuthSession }): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Key01Icon size={16} style={{ color: 'var(--color-accent)' }} /> 1. Configure Agent
      </div>
      <p className="deploy-step-desc" style={{ marginTop: 'var(--spacing-md)' }}>
        Your agent authenticates with a single GhostBroker API key. The delegation
        credential is minted and persisted server-side — you never need to handle
        a W3C VC or a private key.
      </p>
      <p className="deploy-step-desc" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong>Before deploying</strong>, confirm your institution's
        settlement profile in <em>Settings</em>. The default
        <code> wallet:default</code> profile is a noop rail (no external
        transport). If you want real on-chain settlement, switch the
        institution to <code>chain:sepolia:erc20</code> and configure the
        deposit address + per-asset token addresses on the
        <em> Settlement profile</em> card.
      </p>
      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-lg)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ClipboardIcon size={16} style={{ color: 'var(--color-accent)' }} /> Platform Values
        </div>
        <div className="deploy-credentials" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', marginTop: 'var(--spacing-md)' }}>
          <CopyField label="GhostBroker URL" value={API_BASE_URL} />
          <CopyField label="Telemetry WebSocket URL" value={TELEMETRY_WS_URL} />
          <CopyField label="Institution ID" value={session.institution.id} />
        </div>
      </div>
      <div className="deploy-info-card" style={{ marginTop: 'var(--spacing-md)' }}>
        <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Shield01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Required Secrets
        </div>
        <ul className="deploy-info-list" style={{ marginTop: 'var(--spacing-sm)' }}>
          <li><strong>GhostBroker API Key</strong> - Generate from the Developer Keys tab on the dashboard.</li>
          <li><strong>LLM API Key</strong> - Your OpenAI, Groq, or Anthropic API key.</li>
        </ul>
      </div>
      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Idea01Icon size={14} style={{ color: 'var(--color-accent)' }} />
          The backend mints and signs the delegation VC automatically. No CLI steps needed.
        </span>
      </div>
    </div>
  );
}

function DeploySection(): React.JSX.Element {
  const dockerComposeSample = `version: "3.9"
services:
  trading-agent:
    build: .
    container_name: ghostbroker-agent
    restart: unless-stopped
    environment:
      - GHOSTBROKER_URL=${API_BASE_URL}
      - GHOSTBROKER_API_KEY=${'${GHOSTBROKER_API_KEY}'}
      - OPENAI_API_KEY=${'${OPENAI_API_KEY}'}
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"`;

  return (
    <div className="deploy-step-content">
      <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <CodeIcon size={16} style={{ color: 'var(--color-accent)' }} /> 2. Deploy Your Agent
      </div>
      <p className="deploy-step-desc" style={{ marginTop: 'var(--spacing-md)' }}>
        Write your agent using the <code>@ghostbroker/agent-client</code> SDK, then
        deploy it with Docker. The agent only needs two env vars to connect.
      </p>
      <CodeBlock code={`import { GhostBrokerClient } from "@ghostbroker/agent-client";
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const GHOSTBROKER_URL = process.env.GHOSTBROKER_URL!;
const GHOSTBROKER_API_KEY = process.env.GHOSTBROKER_API_KEY!;


const ghost = new GhostBrokerClient({ baseUrl: GHOSTBROKER_URL });
const session = await ghost.authenticateWithApiKey(GHOSTBROKER_API_KEY);

const privateKey = randomBytes(32);
const publicKey = secp256k1.getPublicKey(privateKey, true);
const agentDid = \`did:t3n:\${Buffer.from(publicKey).toString("hex").slice(0, 24)}\`;

const admission = await ghost.admitAgent({
  institutionId: session.institution.id,
  agentDid,
});
console.log("Admitted. Authority ref:", admission.authorityRef);

ghost.telemetry.onSettled(async (ref) => console.log("Trade finalized:", ref));
ghost.telemetry.connect();
console.log("Agent running. Waiting for trades...");`} language="typescript" />
      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Package01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Install the SDK:
        </strong>
        <CodeBlock code="npm install @ghostbroker/agent-client @noble/curves @noble/hashes" />
      </div>
      <h3 style={{ marginTop: 'var(--spacing-xl)', marginBottom: 'var(--spacing-sm)' }}>Docker Compose</h3>
      <CodeBlock code={dockerComposeSample} />
      <h3 style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-sm)' }}>Dockerfile</h3>
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
CMD ["node", "dist/agent.js"]`} language="dockerfile" />
    </div>
  );
}

function MonitorSection({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <div className="deploy-step-content">
      <div className="deploy-info-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Chart01Icon size={16} style={{ color: 'var(--color-accent)' }} /> 3. Monitor
      </div>
      <p className="deploy-step-desc" style={{ marginTop: 'var(--spacing-md)' }}>
        Once deployed, your agent appears in the Observatory Console.
      </p>
      <div className="deploy-monitor-grid" style={{ marginTop: 'var(--spacing-lg)' }}>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon"><Plug01Icon size={24} style={{ color: 'var(--color-success)' }} /></div>
          <div className="deploy-monitor-title">Connection Status</div>
          <div className="deploy-monitor-desc">Real-time telemetry on the dashboard.</div>
        </div>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon"><Chart01Icon size={24} style={{ color: 'var(--color-accent)' }} /></div>
          <div className="deploy-monitor-title">Activity Feed</div>
          <div className="deploy-monitor-desc">Agent events: admission, intents, settlements.</div>
        </div>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon"><Link01Icon size={24} style={{ color: 'var(--color-accent)' }} /></div>
          <div className="deploy-monitor-title">Connected Agents</div>
          <div className="deploy-monitor-desc">All admitted agents with status badges.</div>
        </div>
        <div className="deploy-monitor-card">
          <div className="deploy-monitor-icon"><ScrollIcon size={24} style={{ color: 'var(--color-accent)' }} /></div>
          <div className="deploy-monitor-title">Trade History</div>
          <div className="deploy-monitor-desc">Completed trades with audit receipts.</div>
        </div>
      </div>
      <div className="deploy-tip-box" style={{ marginTop: 'var(--spacing-md)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <Idea01Icon size={14} style={{ color: 'var(--color-accent)' }} />
          Open telemetry at <code>{TELEMETRY_WS_URL}?institutionId=&lt;uuid&gt;</code>.
        </span>
      </div>
      <div style={{ marginTop: 'var(--spacing-lg)', textAlign: 'center', padding: 'var(--spacing-lg)' }}>
        <button type="button" className="btn btn-primary" onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <EyeIcon size={14} /> Return to Observatory Console
        </button>
      </div>
    </div>
  );
}

export function AgentDeploymentGuide({ session, onBack }: AgentDeploymentGuideProps): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<Section>('configure');
  const sections: { id: Section; label: string; icon: React.JSX.Element }[] = [
    { id: 'configure', label: 'Configure Agent', icon: <Key01Icon size={14} /> },
    { id: 'deploy', label: 'Deploy', icon: <CodeIcon size={14} /> },
    { id: 'monitor', label: 'Monitor', icon: <Chart01Icon size={14} /> },
  ];
  return (
    <div className="deploy-layout">
      <header className="deploy-header">
        <div className="deploy-header-left">
          <button type="button" className="btn btn-secondary" onClick={onBack}>&larr; Back</button>
        </div>
        <div className="deploy-header-center">
          <h1 className="deploy-title">Deploy Your Agent</h1>
          <span className="deploy-subtitle">Connect your agent to GhostBroker</span>
        </div>
      </header>
      <div className="deploy-steps-indicator" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`deploy-step-tab ${activeSection === section.id ? 'active' : ''}`}
            onClick={() => setActiveSection(section.id)}
          >
            <div className="deploy-step-tab-content">
              <div className="deploy-step-tab-icon">{section.icon}</div>
              <div className="deploy-step-tab-info">
                <span className="deploy-step-tab-label">{section.label}</span>
              </div>
            </div>
            <div className="deploy-step-tab-indicator-bar" />
          </button>
        ))}
      </div>
      <div className="deploy-content">
        {activeSection === 'configure' && <ConfigureSection session={session} />}
        {activeSection === 'deploy' && <DeploySection />}
        {activeSection === 'monitor' && <MonitorSection onBack={onBack} />}
      </div>
    </div>
  );
}

export default AgentDeploymentGuide;
