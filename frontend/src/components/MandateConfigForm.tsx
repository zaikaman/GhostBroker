import React, { useMemo, useState } from 'react';
import {
  AlertCircleIcon,
  CheckmarkCircle01Icon,
  Loading03Icon,
  Shield01Icon,
} from 'hugeicons-react';
import {
  apiClient,
  type AuthoredMandatePolicy,
  type CreateNegotiationMandateRequest,
  type NegotiationExecutionStyle,
  type NegotiationValuationSource,
} from '../services/api-client';
 
/**
 * Default authored policy mandate. The operator authors business
 * intent here; the numeric execution rails (reference price, band,
 * max notional) are DERIVED from this by the backend strategy
 * normalizer, never typed directly in this primary surface.
 */
function buildDefaultMandate(deadlineOffsetMs = 60 * 60 * 1000): AuthoredMandatePolicy {
  return {
    objective:
      'Acquire strategic block exposure quietly through a confidential counterparty, prioritising execution quality and discretion over speed.',
    assetCode: 'WBTC',
    side: 'buy',
    sizePolicy: {
      targetQuantity: 1,
      minimumQuantity: 0.5,
      partialExecutionAllowed: true,
    },
    urgency: 'normal',
    executionStyle: 'trust_first',
    valuationPolicy: {
      source: 'operator_note',
      anchorValue: 70000,
      note: 'Anchor on our internal treasury fair value for this asset.',
    },
    concessionPolicy: {
      pace: 'patient',
      maxConcessionBps: 150,
    },
    disclosurePolicy: {
      allowLadder: ['accredited_institution', 'settlement_capacity'],
      requireReciprocityFor: [],
    },
    counterpartyRequirements: {
      requiredClaims: ['accredited_institution', 'settlement_capacity'],
      disallowedTraits: [],
    },
    approvalPolicy: {
      mode: 'auto_settle',
      preferredEnvelopeNote:
        'Settle autonomously once terms are inside the derived envelope and trust is established.',
    },
    timeWindow: {
      deadline: new Date(Date.now() + deadlineOffsetMs).toISOString(),
    },
    operatorInstructions:
      'Negotiate patiently. Build trust through selective disclosure before improving terms. Walk away cleanly if disclosure requirements are not satisfied.',
  };
}
 
/**
 * Client-side preview of the derived rails. Mirrors the backend
 * strategy normalizer's style/urgency math so the operator can see the
 * bounds their policy implies without typing them. Authoritative
 * derivation happens on the backend.
 */
function previewDerivedRails(policy: AuthoredMandatePolicy): {
  anchor: number;
  bandBps: number;
  walkawayMin: number;
  walkawayMax: number;
  notionalCeiling: number;
} {
  const anchor =
    policy.valuationPolicy.anchorValue && policy.valuationPolicy.anchorValue > 0
      ? policy.valuationPolicy.anchorValue
      : 0;
  if (anchor <= 0) {
    return { anchor: 0, bandBps: 0, walkawayMin: 0, walkawayMax: 0, notionalCeiling: 0 };
  }
 
  const styleMult: Record<NegotiationExecutionStyle, number> = {
    patient: 0.6,
    balanced: 1.0,
    aggressive: 1.6,
    relationship_first: 0.7,
    trust_first: 0.5,
  };
  const urgencyLean: Record<AuthoredMandatePolicy['urgency'], number> = {
    low: -0.3,
    normal: 0.0,
    high: 0.3,
    critical: 0.6,
  };
  const lean = Math.max(0, urgencyLean[policy.urgency]);
  const bandMultiplier = Math.max(0.2, styleMult[policy.executionStyle] * (1 + lean * 0.6));
  const bandBps = Math.round(150 * bandMultiplier);
  const band = anchor * (bandBps / 10_000);
  return {
    anchor,
    bandBps,
    walkawayMin: Math.max(0, anchor - band),
    walkawayMax: anchor + band,
    notionalCeiling: anchor * policy.sizePolicy.targetQuantity,
  };
}
 
const EXECUTION_STYLE_OPTIONS: {
  value: NegotiationExecutionStyle;
  label: string;
  hint: string;
}[] = [
  { value: 'patient', label: 'Patient', hint: 'Tight bounds, holds for better terms.' },
  { value: 'balanced', label: 'Balanced', hint: 'Steady concession, mid tempo.' },
  { value: 'aggressive', label: 'Aggressive', hint: 'Wide bounds, front-loaded concession.' },
  { value: 'relationship_first', label: 'Relationship-first', hint: 'Values repeat counterparty trust.' },
  { value: 'trust_first', label: 'Trust-first', hint: 'Tight until disclosure/trust is proven.' },
];
 
const VALUATION_SOURCE_OPTIONS: {
  value: NegotiationValuationSource;
  label: string;
  hint: string;
}[] = [
  { value: 'auto_anchor', label: 'Auto-anchor (oracle)', hint: 'Runtime resolves a market value.' },
  { value: 'internal_fair_value', label: 'Internal fair value', hint: 'Use our treasury fair value.' },
  { value: 'operator_note', label: 'Operator valuation note', hint: 'Anchor on the value you specify below.' },
];
 
const SECTION_LABEL_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '0.7rem',
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--color-accent)',
};
 
const SECTION_CARD_STYLE: React.CSSProperties = {
  display: 'grid',
  gap: '12px',
  padding: '18px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border)',
  background: 'rgba(255, 255, 255, 0.018)',
};
 
export function MandateConfigForm({
  agentId,
  onSuccess,
}: {
  agentId: string;
  onSuccess?: () => void;
}): React.JSX.Element {
  const [mandate, setMandate] = useState<AuthoredMandatePolicy>(buildDefaultMandate);
  const [claimsInput, setClaimsInput] = useState('accredited_institution, settlement_capacity');
  const [requiredClaimsInput, setRequiredClaimsInput] = useState(
    'accredited_institution, settlement_capacity',
  );
  const [disallowedInput, setDisallowedInput] = useState('');
  // Lazy initializer runs once on mount so the deadline anchor is
  // computed at component creation time (the lint rule rejects
  // `Date.now()` calls inside the render body).
  const [deadlineLocal, setDeadlineLocal] = useState(() =>
    new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
 
  const rails = useMemo(() => previewDerivedRails(mandate), [mandate]);
 
  function patch<K extends keyof AuthoredMandatePolicy>(
    key: K,
    value: AuthoredMandatePolicy[K],
  ): void {
    setMandate((prev) => ({ ...prev, [key]: value }));
  }
 
  function patchSizePolicy<K extends keyof AuthoredMandatePolicy['sizePolicy']>(
    key: K,
    value: AuthoredMandatePolicy['sizePolicy'][K],
  ): void {
    setMandate((prev) => ({
      ...prev,
      sizePolicy: { ...prev.sizePolicy, [key]: value },
    }));
  }
 
  function patchValuation<K extends keyof AuthoredMandatePolicy['valuationPolicy']>(
    key: K,
    value: AuthoredMandatePolicy['valuationPolicy'][K],
  ): void {
    setMandate((prev) => ({
      ...prev,
      valuationPolicy: { ...prev.valuationPolicy, [key]: value },
    }));
  }
 
  function patchConcession<K extends keyof AuthoredMandatePolicy['concessionPolicy']>(
    key: K,
    value: AuthoredMandatePolicy['concessionPolicy'][K],
  ): void {
    setMandate((prev) => ({
      ...prev,
      concessionPolicy: { ...prev.concessionPolicy, [key]: value },
    }));
  }
 
  function patchApproval<K extends keyof AuthoredMandatePolicy['approvalPolicy']>(
    key: K,
    value: AuthoredMandatePolicy['approvalPolicy'][K],
  ): void {
    setMandate((prev) => ({
      ...prev,
      approvalPolicy: { ...prev.approvalPolicy, [key]: value },
    }));
  }
 
  function parseList(input: string): string[] {
    return input
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
 
  function validate(): string | null {
    if (!mandate.objective.trim()) return 'Objective is required.';
    if (!mandate.assetCode.trim()) return 'Asset code is required.';
    if (!(mandate.sizePolicy.targetQuantity > 0))
      return 'Target quantity must be greater than zero.';
    if (mandate.sizePolicy.minimumQuantity < 0)
      return 'Minimum quantity cannot be negative.';
    if (mandate.sizePolicy.minimumQuantity > mandate.sizePolicy.targetQuantity)
      return 'Minimum quantity cannot exceed the target quantity.';
    if (mandate.valuationPolicy.source !== 'auto_anchor') {
      if (!(mandate.valuationPolicy.anchorValue && mandate.valuationPolicy.anchorValue > 0)) {
        return `${VALUATION_SOURCE_OPTIONS.find((opt) => opt.value === mandate.valuationPolicy.source)?.label ?? 'This valuation source'} requires an anchor value.`;
      }
    }
    if (!(mandate.concessionPolicy.maxConcessionBps >= 0))
      return 'Max concession budget must be zero or greater.';
    if (!mandate.operatorInstructions.trim())
      return 'Operator strategy note is required.';
    if (!deadlineLocal.trim() || Number.isNaN(new Date(deadlineLocal).getTime()))
      return 'Deadline must be a valid date and time.';
    return null;
  }
 
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      setMessage(null);
      return;
    }
 
    setIsSubmitting(true);
    setError(null);
    setMessage(null);
 
    try {
      const finalMandate: AuthoredMandatePolicy = {
        ...mandate,
        assetCode: mandate.assetCode.trim().toUpperCase(),
        objective: mandate.objective.trim(),
        operatorInstructions: mandate.operatorInstructions.trim(),
        disclosurePolicy: {
          ...mandate.disclosurePolicy,
          allowLadder: parseList(claimsInput),
        },
        counterpartyRequirements: {
          ...mandate.counterpartyRequirements,
          requiredClaims: parseList(requiredClaimsInput),
          disallowedTraits: parseList(disallowedInput),
        },
        valuationPolicy: {
          ...mandate.valuationPolicy,
          ...(mandate.valuationPolicy.source === 'auto_anchor'
            ? {}
            : { anchorValue: mandate.valuationPolicy.anchorValue }),
        },
        timeWindow: {
          deadline: new Date(deadlineLocal).toISOString(),
        },
      };
 
      const request: CreateNegotiationMandateRequest = { authored: finalMandate };
      await apiClient.createNegotiationMandate(agentId, request);
      setMessage('Negotiation mandate committed. Derived execution rails sealed inside the enclave.');
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create negotiation mandate.');
    } finally {
      setIsSubmitting(false);
    }
  }
 
  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Author negotiation mandate"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}
    >
      <div style={{ display: 'grid', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield01Icon size={16} style={{ color: 'var(--color-accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.82rem', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', color: 'var(--color-text-primary)', textTransform: 'uppercase' }}>
            Author Negotiation Mandate
          </h3>
        </div>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: '0.78rem', maxWidth: '72ch' }}>
          Issue instructions to a confidential broker. The agent decides strategy, concession pacing, disclosure
          choices, and deal construction within the limits implied by this policy. Numeric execution rails are derived
          automatically — not typed.
        </p>
      </div>
 
      {/* Objective */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Objective</h4>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-objective">What should the institution accomplish?</label>
          <textarea
            id="mandate-objective"
            className="form-input"
            rows={3}
            placeholder="e.g. Acquire strategic BTC exposure quietly; reduce treasury WBTC position; find quiet block liquidity."
            value={mandate.objective}
            onChange={(e) => patch('objective', e.target.value)}
            style={{ resize: 'vertical', minHeight: '72px' }}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-asset">Asset</label>
            <input
              id="mandate-asset"
              className="form-input font-mono"
              value={mandate.assetCode}
              onChange={(e) => patch('assetCode', e.target.value.toUpperCase())}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-side">Side</label>
            <select
              id="mandate-side"
              className="form-select"
              value={mandate.side}
              onChange={(e) => patch('side', e.target.value as 'buy' | 'sell')}
            >
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
        </div>
      </section>
 
      {/* Trade Size */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Trade Size</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-target-qty">Target Block Size</label>
            <input
              id="mandate-target-qty"
              className="form-input font-mono"
              type="number"
              min={0}
              step="any"
              value={mandate.sizePolicy.targetQuantity}
              onChange={(e) => patchSizePolicy('targetQuantity', Number(e.target.value))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-min-qty">Minimum Acceptable Size</label>
            <input
              id="mandate-min-qty"
              className="form-input font-mono"
              type="number"
              min={0}
              step="any"
              value={mandate.sizePolicy.minimumQuantity}
              onChange={(e) => patchSizePolicy('minimumQuantity', Number(e.target.value))}
            />
          </div>
        </div>
        <label className="deploy-inline-toggle" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="checkbox"
            checked={mandate.sizePolicy.partialExecutionAllowed}
            onChange={(e) => patchSizePolicy('partialExecutionAllowed', e.target.checked)}
          />
          <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
            Allow partial fills (otherwise full-block only)
          </span>
        </label>
      </section>
 
      {/* Urgency & Tempo */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Urgency &amp; Tempo</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-urgency">Urgency</label>
            <select
              id="mandate-urgency"
              className="form-select"
              value={mandate.urgency}
              onChange={(e) => patch('urgency', e.target.value as AuthoredMandatePolicy['urgency'])}
            >
              <option value="low">Low — can hold</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="critical">Critical — converge fast</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-deadline">Deadline</label>
            <input
              id="mandate-deadline"
              className="form-input"
              type="datetime-local"
              value={deadlineLocal}
              onChange={(e) => setDeadlineLocal(e.target.value)}
            />
          </div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-style">Execution Posture</label>
          <select
            id="mandate-style"
            className="form-select"
            value={mandate.executionStyle}
            onChange={(e) => patch('executionStyle', e.target.value as NegotiationExecutionStyle)}
          >
            {EXECUTION_STYLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-text-muted)', fontSize: '0.68rem' }}>
            {EXECUTION_STYLE_OPTIONS.find((opt) => opt.value === mandate.executionStyle)?.hint}
          </span>
        </div>
      </section>
 
      {/* Valuation Policy */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Valuation Policy</h4>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-valuation-source">Anchor Source</label>
          <select
            id="mandate-valuation-source"
            className="form-select"
            value={mandate.valuationPolicy.source}
            onChange={(e) => patchValuation('source', e.target.value as NegotiationValuationSource)}
          >
            {VALUATION_SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-text-muted)', fontSize: '0.68rem' }}>
            {VALUATION_SOURCE_OPTIONS.find((opt) => opt.value === mandate.valuationPolicy.source)?.hint}
          </span>
        </div>
        {mandate.valuationPolicy.source !== 'auto_anchor' && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-anchor">Anchor Value (per unit, USD)</label>
            <input
              id="mandate-anchor"
              className="form-input font-mono"
              type="number"
              min={0}
              step="any"
              value={mandate.valuationPolicy.anchorValue ?? ''}
              onChange={(e) => patchValuation('anchorValue', e.target.value ? Number(e.target.value) : undefined)}
            />
            <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-text-muted)', fontSize: '0.68rem' }}>
              Used to derive the reservation bounds. The operator does not set live quoting directly.
            </span>
          </div>
        )}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-valuation-note">Valuation Note (optional)</label>
          <input
            id="mandate-valuation-note"
            className="form-input"
            value={mandate.valuationPolicy.note ?? ''}
            onChange={(e) => patchValuation('note', e.target.value || undefined)}
            placeholder="Free-text guidance for the agent."
          />
        </div>
      </section>
 
      {/* Concession Policy */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Concession Policy</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-pace">Concession Pace</label>
            <select
              id="mandate-pace"
              className="form-select"
              value={mandate.concessionPolicy.pace}
              onChange={(e) => patchConcession('pace', e.target.value as AuthoredMandatePolicy['concessionPolicy']['pace'])}
            >
              <option value="patient">Patient — small steps, late</option>
              <option value="balanced">Balanced</option>
              <option value="aggressive">Aggressive — front-loaded</option>
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="mandate-max-concession">Max Concession Budget (bps)</label>
            <input
              id="mandate-max-concession"
              className="form-input font-mono"
              type="number"
              min={0}
              step="any"
              value={mandate.concessionPolicy.maxConcessionBps}
              onChange={(e) => patchConcession('maxConcessionBps', Number(e.target.value))}
            />
          </div>
        </div>
      </section>
 
      {/* Trust & Counterparty */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Trust &amp; Counterparty</h4>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-required-claims">Required Counterparty Proofs</label>
          <input
            id="mandate-required-claims"
            className="form-input"
            placeholder="accredited_institution, settlement_capacity"
            value={requiredClaimsInput}
            onChange={(e) => setRequiredClaimsInput(e.target.value)}
          />
          <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-text-muted)', fontSize: '0.68rem' }}>
            Claim types the counterparty must prove (via Terminal 3 attestation) before convergence.
          </span>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-disallowed">Disallowed Counterparty Traits (optional)</label>
          <input
            id="mandate-disallowed"
            className="form-input"
            placeholder="sanctioned_jurisdiction"
            value={disallowedInput}
            onChange={(e) => setDisallowedInput(e.target.value)}
          />
        </div>
      </section>
 
      {/* Disclosure Rules */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Disclosure Rules</h4>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-disclosable">Claims This Agent May Reveal (suggested order)</label>
          <input
            id="mandate-disclosable"
            className="form-input"
            placeholder="accredited_institution, settlement_capacity"
            value={claimsInput}
            onChange={(e) => setClaimsInput(e.target.value)}
          />
          <span style={{ display: 'block', marginTop: '4px', color: 'var(--color-text-muted)', fontSize: '0.68rem' }}>
            The agent reveals these selectively to build trust; order is a suggestion, not a hard sequence.
          </span>
        </div>
      </section>
 
      {/* Decision Policy */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Decision Policy</h4>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-approval">Approval Mode</label>
          <select
            id="mandate-approval"
            className="form-select"
            value={mandate.approvalPolicy.mode}
            onChange={(e) => patchApproval('mode', e.target.value as AuthoredMandatePolicy['approvalPolicy']['mode'])}
          >
            <option value="auto_settle">Auto-settle inside mandate</option>
            <option value="escalate_outside_envelope">Escalate to operator outside preferred envelope</option>
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-envelope">Preferred Outcome Note (optional)</label>
          <input
            id="mandate-envelope"
            className="form-input"
            value={mandate.approvalPolicy.preferredEnvelopeNote ?? ''}
            onChange={(e) => patchApproval('preferredEnvelopeNote', e.target.value || undefined)}
            placeholder="Describe the preferred outcome in words, not numbers."
          />
        </div>
      </section>
 
      {/* Operator Strategy Note */}
      <section style={SECTION_CARD_STYLE}>
        <h4 style={SECTION_LABEL_STYLE}>Operator Strategy Note</h4>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label" htmlFor="mandate-instructions">Strategic Guidance</label>
          <textarea
            id="mandate-instructions"
            className="form-input"
            rows={3}
            placeholder="Free-text instructions: how to sequence concessions, when to escalate, when to walk away."
            value={mandate.operatorInstructions}
            onChange={(e) => patch('operatorInstructions', e.target.value)}
            style={{ resize: 'vertical', minHeight: '72px' }}
          />
        </div>
      </section>
 
      {/* Derived Rails Preview */}
      <section style={{ ...SECTION_CARD_STYLE, background: 'rgba(94, 210, 156, 0.03)', borderColor: 'rgba(94, 210, 156, 0.15)' }}>
        <h4 style={{ ...SECTION_LABEL_STYLE, color: 'var(--color-text-secondary)' }}>Derived Execution Rails (preview)</h4>
        <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '0.7rem', maxWidth: '64ch' }}>
          Computed from your policy. The enclave seals the authoritative bounds; these are shown for operator awareness only.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', fontFamily: 'var(--font-mono)', fontSize: '0.74rem' }}>
          <DerivedRailStat label="Anchor" value={rails.anchor > 0 ? `$${rails.anchor.toFixed(2)}` : '—'} />
          <DerivedRailStat label="Band" value={rails.bandBps > 0 ? `${rails.bandBps} bps` : '—'} />
          <DerivedRailStat label="Walkaway Min" value={rails.walkawayMin > 0 ? `$${rails.walkawayMin.toFixed(2)}` : '—'} />
          <DerivedRailStat label="Walkaway Max" value={rails.walkawayMax > 0 ? `$${rails.walkawayMax.toFixed(2)}` : '—'} />
          <DerivedRailStat label="Notional Ceiling" value={rails.notionalCeiling > 0 ? `$${rails.notionalCeiling.toFixed(2)}` : '—'} />
        </div>
      </section>
 
      {error && (
        <div role="alert" className="status-badge error" style={{ justifyContent: 'center', padding: 'var(--spacing-sm)' }}>
          <AlertCircleIcon size={14} /> {error}
        </div>
      )}
      {message && (
        <div role="status" className="status-badge secure" style={{ justifyContent: 'center', padding: 'var(--spacing-sm)', gap: '8px' }}>
          <CheckmarkCircle01Icon size={14} /> {message}
        </div>
      )}
 
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={isSubmitting}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '10px 20px', fontSize: '0.8rem' }}
        >
          {isSubmitting ? <Loading03Icon size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Shield01Icon size={14} />}
          {isSubmitting ? 'Committing...' : 'Commit Mandate'}
        </button>
      </div>
    </form>
  );
}
 
function DerivedRailStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gap: '2px', padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: '0.6rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--color-text-primary)' }}>{value}</span>
    </div>
  );
}