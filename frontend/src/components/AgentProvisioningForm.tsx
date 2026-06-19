import React, { useState } from 'react';
import { CheckmarkCircle01Icon, Loading03Icon, Robot01Icon } from 'hugeicons-react';
import { apiClient, type Agent } from '../services/api-client';
import { generateAgentIdentity } from '../services/agent-identity';

interface AgentProvisioningFormProps {
  institutionId: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  onProvisioned?: (agent: Agent) => void | Promise<void>;
}

interface ProvisioningFormState {
  label: string;
  maxSpendUsd: string;
}

const defaultFormState: ProvisioningFormState = {
  label: '',
  maxSpendUsd: '50000',
};

export function AgentProvisioningForm({
  institutionId,
  title = 'Provision Agent',
  description = 'Create an operator-ready agent record, mint delegation, and admit it in one action.',
  submitLabel = 'Provision Agent',
  onProvisioned,
}: AgentProvisioningFormProps): React.JSX.Element {
  const [form, setForm] = useState<ProvisioningFormState>(defaultFormState);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!form.label.trim()) {
      setError('Agent label is required.');
      return;
    }


    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      // Mint a fresh secp256k1 keypair in the browser and derive
      // `did:t3n:0x<eth-address>` so the agent's delegation VC is
      // cryptographically bound to a keypair the dashboard actually
      // holds (not a backend-minted placeholder). The private key
      // stays in memory; only the public DID crosses the wire.
      const identity = generateAgentIdentity();

      const result = await apiClient.provisionAgent({
        institutionId,
        agentDid: identity.agentDid,
        label: form.label.trim(),
        policy: {
          maxSpendUsd: Number(form.maxSpendUsd),
          allowedActions: ['agent.admit', 'intent.submit', 'negotiation.open', 'negotiation.move', 'negotiation.disclose', 'negotiation.settle'],
        },
      });

      setSuccess(`${result.agent.label ?? result.agent.agentDid} is admitted and ready for mandate binding.`);
      setForm((current) => ({
        ...current,
        label: '',
      }));
      await onProvisioned?.(result.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to provision agent.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--spacing-md)',
        padding: '1.25rem',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--color-border)',
        background: 'rgba(255, 255, 255, 0.018)',
      }}
    >
      <div style={{ display: 'grid', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-primary)' }}>
          <Robot01Icon size={16} style={{ color: 'var(--color-accent)' }} />
          <strong style={{ fontSize: '0.82rem', letterSpacing: '0.04em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>{title}</strong>
        </div>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: '0.8rem', maxWidth: '70ch' }}>{description}</p>
      </div>

      {error ? (
        <div className="status-badge error" style={{ justifyContent: 'center', padding: 'var(--spacing-sm)' }}>
          {error}
        </div>
      ) : null}

      {success ? (
        <div className="status-badge secure" style={{ justifyContent: 'center', padding: 'var(--spacing-sm)', gap: '8px' }}>
          <CheckmarkCircle01Icon size={14} /> {success}
        </div>
      ) : null}      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div className="form-group">
          <label className="form-label" htmlFor="agent-provision-label">Agent Label</label>
          <input
            id="agent-provision-label"
            className="form-input"
            value={form.label}
            onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
            placeholder="Northstar Negotiator"
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="agent-provision-spend">Delegation Limit (USD)</label>
          <input
            id="agent-provision-spend"
            className="form-input font-mono"
            value={form.maxSpendUsd}
            onChange={(event) => setForm((current) => ({ ...current, maxSpendUsd: event.target.value }))}
            inputMode="numeric"
          />
          <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-text-muted)', fontSize: '0.68rem', lineHeight: 1.5 }}>
            This delegation limit caps the credential itself. Trading-specific notional bounds are defined in the mandate step that follows.
          </span>
        </div>
      </div>





      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Robot01Icon size={14} />} {submitLabel}
        </button>
      </div>
    </div>
  );
}

export default AgentProvisioningForm;
