import React, { useMemo, useState } from 'react';
import { apiClient, type CreateNegotiationMandateRequest } from '../services/api-client';

const initialState: CreateNegotiationMandateRequest = {
  assetCode: 'WBTC',
  side: 'buy',
  targetQuantity: 1,
  referencePrice: 70000,
  priceBandBps: 200,
  deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16),
  urgency: 'normal',
  maxNotional: '70000',
  disclosableClaims: [],
  requiredCounterpartyClaims: {},
  counterpartyConstraints: {},
  operatorPrompt: '',
};

export function MandateConfigForm({
  agentId,
  onSuccess,
}: {
  agentId: string;
  onSuccess?: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState<CreateNegotiationMandateRequest>(initialState);
  const [disclosableClaimsInput, setDisclosableClaimsInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const impliedBand = useMemo(() => {
    const spread = form.referencePrice * (form.priceBandBps / 10000);
    return {
      min: Math.max(0, form.referencePrice - spread),
      max: form.referencePrice + spread,
    };
  }, [form.referencePrice, form.priceBandBps]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      await apiClient.createNegotiationMandate(agentId, {
        ...form,
        deadline: new Date(form.deadline).toISOString(),
        disclosableClaims: disclosableClaimsInput
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setMessage('Negotiation mandate committed and delegation re-minted.');
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create negotiation mandate.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function updateField<K extends keyof CreateNegotiationMandateRequest>(
    key: K,
    value: CreateNegotiationMandateRequest[K],
  ): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Configure negotiation mandate"
      className="card"
      style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '24px' }}
    >
      <h3 style={{ margin: 0, fontSize: '0.9rem', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', color: 'var(--color-text-primary)' }}>
        CONFIGURE NEGOTIATION MANDATE
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-asset">Asset Code</label>
          <input
            id="mandate-asset"
            className="form-input"
            value={form.assetCode}
            onChange={(e) => updateField('assetCode', e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-side">Side</label>
          <select
            id="mandate-side"
            className="form-input"
            value={form.side}
            onChange={(e) => updateField('side', e.target.value as 'buy' | 'sell')}
          >
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-qty">Target Quantity</label>
          <input
            id="mandate-qty"
            className="form-input"
            type="number"
            min={0}
            step="any"
            value={form.targetQuantity}
            onChange={(e) => updateField('targetQuantity', Number(e.target.value))}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-price">Reference Price</label>
          <input
            id="mandate-price"
            className="form-input"
            type="number"
            min={0}
            step="any"
            value={form.referencePrice}
            onChange={(e) => updateField('referencePrice', Number(e.target.value))}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-bps">Band (bps)</label>
          <input
            id="mandate-bps"
            className="form-input"
            type="number"
            min={0}
            max={10000}
            value={form.priceBandBps}
            onChange={(e) => updateField('priceBandBps', Number(e.target.value))}
            required
          />
        </div>
      </div>

      <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
        Implied price band: {impliedBand.min.toFixed(2)} – {impliedBand.max.toFixed(2)}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-notional">Max Notional</label>
          <input
            id="mandate-notional"
            className="form-input"
            type="number"
            min={0}
            step="any"
            value={form.maxNotional}
            onChange={(e) => updateField('maxNotional', e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-urgency">Urgency</label>
          <select
            id="mandate-urgency"
            className="form-input"
            value={form.urgency}
            onChange={(e) => updateField('urgency', e.target.value as CreateNegotiationMandateRequest['urgency'])}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="mandate-deadline">Deadline</label>
          <input
            id="mandate-deadline"
            className="form-input"
            type="datetime-local"
            value={form.deadline}
            onChange={(e) => updateField('deadline', e.target.value)}
            required
          />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="mandate-claims">Disclosable Claims (comma-separated)</label>
        <input
          id="mandate-claims"
          className="form-input"
          placeholder="accredited_institution, settlement_capacity"
          value={disclosableClaimsInput}
          onChange={(e) => setDisclosableClaimsInput(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="mandate-prompt">Operator Prompt</label>
        <textarea
          id="mandate-prompt"
          className="form-input"
          rows={3}
          placeholder="Negotiation instructions for the agent..."
          value={form.operatorPrompt}
          onChange={(e) => updateField('operatorPrompt', e.target.value)}
          required
          style={{ resize: 'vertical', minHeight: '70px' }}
        />
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, color: '#e05c5c', fontSize: '0.8rem' }}>{error}</p>
      )}
      {message && (
        <p role="status" style={{ margin: 0, color: 'var(--color-accent)', fontSize: '0.8rem' }}>{message}</p>
      )}

      <button
        type="submit"
        className="btn btn-primary"
        disabled={isSubmitting}
        style={{ alignSelf: 'flex-start', padding: '10px 20px', fontSize: '0.8rem' }}
      >
        {isSubmitting ? 'Committing...' : 'Commit Mandate'}
      </button>
    </form>
  );
}
