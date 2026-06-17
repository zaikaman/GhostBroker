import React, { useState } from 'react';
import { CheckmarkCircle01Icon, Loading03Icon, Robot01Icon } from 'hugeicons-react';
import { apiClient, type Agent, type ProvisionAgentRequest } from '../services/api-client';

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
  approverEmail: string;
  purpose: string;
  validityMonths: string;
  allowedCategories: ProvisionAgentRequest['policy']['allowedCategories'];
}

const categoryOptions: Array<{
  label: string;
  value: ProvisionAgentRequest['policy']['allowedCategories'][number];
}> = [
  { label: 'Services', value: 'services' },
  { label: 'Software', value: 'software' },
  { label: 'Hardware', value: 'hardware' },
  { label: 'Travel', value: 'travel' },
  { label: 'Office Supplies', value: 'office-supplies' },
];

const defaultFormState: ProvisioningFormState = {
  label: '',
  maxSpendUsd: '50000',
  approverEmail: '',
  purpose: 'Provision delegation for hosted negotiation under institution-approved mandates.',
  validityMonths: '12',
  allowedCategories: ['services'],
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

  const handleCategoryToggle = (value: ProvisioningFormState['allowedCategories'][number]) => {
    setForm((current) => ({
      ...current,
      allowedCategories: current.allowedCategories.includes(value)
        ? current.allowedCategories.filter((item) => item !== value)
        : [...current.allowedCategories, value],
    }));
  };

  const handleSubmit = async () => {
    if (!form.label.trim()) {
      setError('Agent label is required.');
      return;
    }
    if (form.allowedCategories.length === 0) {
      setError('Select at least one delegation category.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await apiClient.provisionAgent({
        institutionId,
        label: form.label.trim(),
        policy: {
          maxSpendUsd: Number(form.maxSpendUsd),
          allowedCategories: form.allowedCategories,
          ...(form.approverEmail.trim() ? { approverEmail: form.approverEmail.trim() } : {}),
          ...(form.purpose.trim() ? { purpose: form.purpose.trim() } : {}),
          ...(form.validityMonths.trim() ? { validityMonths: Number(form.validityMonths) } : {}),
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
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
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
          <label className="form-label" htmlFor="agent-provision-approver">Approver Email</label>
          <input
            id="agent-provision-approver"
            className="form-input"
            value={form.approverEmail}
            onChange={(event) => setForm((current) => ({ ...current, approverEmail: event.target.value }))}
            placeholder="compliance@institution.com"
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
        <div className="form-group">
          <label className="form-label" htmlFor="agent-provision-validity">Validity (months)</label>
          <input
            id="agent-provision-validity"
            className="form-input font-mono"
            value={form.validityMonths}
            onChange={(event) => setForm((current) => ({ ...current, validityMonths: event.target.value }))}
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="agent-provision-purpose">Delegation Purpose</label>
        <textarea
          id="agent-provision-purpose"
          className="form-input"
          value={form.purpose}
          onChange={(event) => setForm((current) => ({ ...current, purpose: event.target.value }))}
          rows={3}
          style={{ resize: 'vertical' }}
        />
        <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-text-muted)', fontSize: '0.68rem', lineHeight: 1.5 }}>
          Keep this broad and institutional. Asset, side, and max notional policy belong to the agent mandate, not the base delegation.
        </span>
      </div>

      <div className="form-group">
        <span className="form-label">Delegation Categories</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {categoryOptions.map((option) => {
            const checked = form.allowedCategories.includes(option.value);
            return (
              <label
                key={option.value}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  borderRadius: '999px',
                  border: checked ? '1px solid rgba(94, 210, 156, 0.38)' : '1px solid var(--color-border)',
                  background: checked ? 'rgba(94, 210, 156, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                  color: checked ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                  fontSize: '0.74rem',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => handleCategoryToggle(option.value)}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
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
