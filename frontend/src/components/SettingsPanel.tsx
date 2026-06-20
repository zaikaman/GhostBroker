import { useState, useEffect, useCallback } from 'react';
import { apiClient, type Agent, type Institution, type EnclaveIdentity } from '../services/api-client';
import {
  Robot01Icon,
  CheckmarkCircle01Icon,
  AlertCircleIcon,
  Loading03Icon,
  Edit02Icon,
  Delete02Icon,
  Key01Icon,
  Refresh01Icon,
  Shield01Icon,
  Cancel01Icon,
} from 'hugeicons-react';
import { PortfolioCard } from './PortfolioCard';
import { SettlementProfileCard } from './SettlementProfileCard';
import { Pagination } from './Pagination';
import { Skeleton } from './Skeleton';

// Custom SVG Gear Icon for Settings to guarantee compatibility
const GearIcon = ({ size = 16, style = {} }: { size?: number; style?: React.CSSProperties }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

interface SettingsPanelProps {
  session: {
    institution: {
      id: string;
      displayName: string;
      t3TenantDid: string;
    };
  };
}

interface DetailRowProps {
  label: string;
  value: string | null;
  isLoading?: boolean;
  isLoadingLabel?: string;
  accent?: string;
  testId?: string;
}

function DetailRow({
  label,
  value,
  isLoading = false,
  isLoadingLabel,
  accent,
  testId,
}: DetailRowProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      style={{
        background: 'var(--color-input-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--spacing-sm)',
      }}
    >
      <div
        style={{
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.6rem',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      {isLoading ? (
        <div style={{ marginTop: '4px' }}>
          <Skeleton variant="text" />
          {isLoadingLabel && (
            <div
              style={{
                marginTop: '2px',
                fontSize: '0.6rem',
                color: 'var(--color-text-muted)',
                fontStyle: 'italic',
              }}
            >
              {isLoadingLabel}
            </div>
          )}
        </div>
      ) : value === null || value === '' ? (
        <div
          style={{
            marginTop: '2px',
            color: 'var(--color-text-muted)',
            fontStyle: 'italic',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Not configured
        </div>
      ) : (
        <div
          style={{
            color: accent ?? 'var(--color-text-primary)',
            wordBreak: 'break-all',
            fontFamily: 'var(--font-mono)',
            marginTop: '2px',
          }}
        >
          {value}
        </div>
      )}
    </div>
  );
}

export function SettingsPanel({ session }: SettingsPanelProps): React.JSX.Element {
  const [activeSubTab, setActiveSubTab] = useState<'mandates' | 'keys' | 'connections' | 'settlement'>('mandates');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [institution, setInstitution] = useState<Institution | null>(null);
  
  const [isAgentsLoading, setIsAgentsLoading] = useState(true);
  const [isInstLoading, setIsInstLoading] = useState(true);
  
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [instError, setInstError] = useState<string | null>(null);
  
  // Key Rotation State
  const [rotatingKeys, setRotatingKeys] = useState(false);
  const [rotateSuccess, setRotateSuccess] = useState<string | null>(null);

  // Policy Form Modal State
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [isSavingPolicy, setIsSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [maxSpendUsd, setMaxSpendUsd] = useState<number>(50000);

  // Pagination State for Mandates
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  // Enclave identity (lazy-loaded when the Connections tab opens)
  const [enclaveIdentity, setEnclaveIdentity] = useState<EnclaveIdentity | null>(null);
  const [isEnclaveLoading, setIsEnclaveLoading] = useState(false);
  const [enclaveError, setEnclaveError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setIsAgentsLoading(true);
    setAgentsError(null);
    try {
      const data = await apiClient.listAgents();
      setAgents(data);
    } catch (err) {
      setAgentsError(err instanceof Error ? err.message : 'Failed to load agents.');
    } finally {
      setIsAgentsLoading(false);
    }
  }, []);

  const loadInstitution = useCallback(async () => {
    setIsInstLoading(true);
    setInstError(null);
    try {
      const data = await apiClient.getInstitution(session.institution.id);
      setInstitution(data);
    } catch (err) {
      setInstError(err instanceof Error ? err.message : 'Failed to load institution details.');
    } finally {
      setIsInstLoading(false);
    }
  }, [session.institution.id]);

  const loadEnclaveIdentity = useCallback(async () => {
    setIsEnclaveLoading(true);
    setEnclaveError(null);
    try {
      const data = await apiClient.getEnclaveIdentity();
      setEnclaveIdentity(data);
    } catch (err) {
      setEnclaveError(err instanceof Error ? err.message : 'Failed to load enclave identity.');
    } finally {
      setIsEnclaveLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    // Schedule data loading asynchronously so that setState calls inside
    // loadAgents/loadInstitution happen outside the effect's synchronous
    // execution, preventing cascading synchronous renders.
    queueMicrotask(() => {
      if (!active) return;
      loadAgents();
      loadInstitution();
    });

    return () => { active = false; };
  }, [loadAgents, loadInstitution]);

  useEffect(() => {
    if (activeSubTab !== 'connections' || enclaveIdentity !== null || isEnclaveLoading) {
      return;
    }
    let active = true;
    queueMicrotask(() => {
      if (active) void loadEnclaveIdentity();
    });
    return () => { active = false; };
  }, [activeSubTab, enclaveIdentity, isEnclaveLoading, loadEnclaveIdentity]);

  const handleRevoke = async (id: string, label: string) => {
    if (!window.confirm(`Are you sure you want to suspend agent "${label || id}"? All active intents from this agent will be cancelled immediately.`)) {
      return;
    }
    try {
      await apiClient.revokeAgent(id);
      await loadAgents();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to suspend agent.');
    }
  };

  const handleOpenEditPolicy = (agent: Agent) => {
    setEditingAgent(agent);
    setPolicyError(null);
    
    // Parse current delegation policy from agent metadata if exists
    const meta = agent.metadata as Record<string, unknown> | undefined;
    const cred = meta?.delegation_credential as Record<string, unknown> | undefined;
    const claims = (cred?.credentialSubject as Record<string, unknown> | undefined)?.["authorityClaims"] as Record<string, unknown>[] | undefined;
    const authorityLimits = claims?.[0]?.authorityLimits as Record<string, unknown> | undefined;
    
    if (authorityLimits) {
      setMaxSpendUsd((authorityLimits.maxSpendUsd as number) || 50000);
    } else {
      setMaxSpendUsd(50000);
    }
  };

  const handleSavePolicy = async () => {
    if (!editingAgent) return;
    setIsSavingPolicy(true);
    setPolicyError(null);
    try {
      const policy: {
        maxSpendUsd: number;
        allowedActions: string[];
      } = {
        maxSpendUsd,
        allowedActions: ['agent.admit', 'intent.submit', 'intent.cancel', 'negotiation.open', 'negotiation.move', 'negotiation.disclose', 'negotiation.settle'],
      };
      await apiClient.mintDelegation(editingAgent.id, policy);
      setEditingAgent(null);
      await loadAgents();
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : 'Failed to regenerate delegation policy.');
    } finally {
      setIsSavingPolicy(false);
    }
  };

  const handleRotateKeys = async () => {
    if (!window.confirm('WARNING: Rotating cryptographic envelope keys will generate new keys inside the TEE enclave. Future receipts and intent envelopes will be encrypted using these new key versions. Existing records will remain decryptable using their historical key versions. Proceed?')) {
      return;
    }
    setRotatingKeys(true);
    setRotateSuccess(null);
    try {
      await apiClient.rotateKeys(session.institution.id);
      const updatedInst = await apiClient.getInstitution(session.institution.id);
      setInstitution(updatedInst);
      setRotateSuccess('Enclave envelope keys rotated successfully. New key versions published.');
      setTimeout(() => setRotateSuccess(null), 5000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to rotate envelope keys.');
    } finally {
      setRotatingKeys(false);
    }
  };




  const totalPages = Math.ceil(agents.length / itemsPerPage);
  const activePage = Math.min(currentPage, Math.max(1, totalPages));
  const paginatedAgents = agents.slice((activePage - 1) * itemsPerPage, activePage * itemsPerPage);

  // Extract envelope keys from institution metadata with proper typing.
  const meta = institution?.metadata as Record<string, unknown> | undefined;
  const envelopeKeys = meta?.envelopeKeys as Record<string, unknown> | undefined;
  const hiddenIntentKey = envelopeKeys?.hidden_intent as Record<string, unknown> | undefined;
  const receiptKey = envelopeKeys?.receipt as Record<string, unknown> | undefined;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 'var(--spacing-lg)', minHeight: '600px' }}>
      
      {/* Sub navigation Sidebar */}
      <div className="card" style={{ padding: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: '6px', height: 'fit-content' }}>
        <h3 style={{ margin: '0 0 var(--spacing-sm) 0', fontSize: '0.65rem', color: 'var(--color-text-muted)', letterSpacing: '0.05em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
          Risk & Security settings
        </h3>
        <button
          type="button"
          onClick={() => setActiveSubTab('mandates')}
          className={`sidebar-link ${activeSubTab === 'mandates' ? 'active' : ''}`}
          style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', border: 'none', background: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
        >
          <Robot01Icon size={14} /> Agent Mandates
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('keys')}
          className={`sidebar-link ${activeSubTab === 'keys' ? 'active' : ''}`}
          style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', border: 'none', background: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
        >
          <Key01Icon size={14} /> Key Management
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('connections')}
          className={`sidebar-link ${activeSubTab === 'connections' ? 'active' : ''}`}
          style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', border: 'none', background: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
        >
          <Shield01Icon size={14} /> Enclave Connection
        </button>
        <button
          type="button"
          onClick={() => setActiveSubTab('settlement')}
          className={`sidebar-link ${activeSubTab === 'settlement' ? 'active' : ''}`}
          style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', border: 'none', background: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
        >
          <GearIcon size={14} /> Settlement Profile
        </button>
      </div>

      {/* Main Settings Content area */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
        
        {/* Tab 1: Agent Mandates */}
        {activeSubTab === 'mandates' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', animation: 'fadeIn 0.2s ease' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--spacing-sm)' }}>
              <div>
                <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>
                  <Robot01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Autonomous Agent Mandates
                </h2>
                <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                  Authorize autonomous enclaved trading DIDs, configure risk bounds, and update spend limits.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                onClick={loadAgents}
                disabled={isAgentsLoading}
              >
                <Refresh01Icon size={12} style={{ animation: isAgentsLoading ? 'spin 1s linear infinite' : 'none' }} /> Refresh
              </button>
            </div>

            {isAgentsLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)', paddingBottom: '10px' }}>
                  <Skeleton variant="text" width="15%" />
                  <Skeleton variant="text" width="30%" />
                  <Skeleton variant="text" width="15%" />
                  <Skeleton variant="text" width="10%" />
                  <Skeleton variant="text" width="15%" />
                </div>
                {[1, 2, 3].map((i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255, 255, 255, 0.02)' }}>
                    <Skeleton variant="text" width="15%" style={{ height: '14px' }} />
                    <div style={{ width: '30%', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <Skeleton variant="text" width="90%" style={{ height: '12px' }} />
                      <Skeleton variant="text" width="60%" style={{ height: '10px' }} />
                    </div>
                    <Skeleton variant="text" width="15%" style={{ height: '14px' }} />
                    <Skeleton variant="rect" width={60} height={18} style={{ borderRadius: '4px' }} />
                    <Skeleton variant="rect" width={80} height={24} style={{ borderRadius: '4px' }} />
                  </div>
                ))}
              </div>
            ) : agentsError ? (
              <div className="status-badge error" style={{ justifyContent: 'center', padding: 'var(--spacing-md)' }}>
                <AlertCircleIcon size={14} /> {agentsError}
              </div>
             ) : agents.length === 0 ? (
               <div style={{ textAlign: 'center', padding: 'var(--spacing-xl)', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                 No active or historical agents found for this institution. Provision an agent first, then bind its mandate here or from Hosted Negotiator.
               </div>
             ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table className="trades-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                        <th style={{ padding: '10px var(--spacing-sm)' }}>Agent Label</th>
                        <th style={{ padding: '10px var(--spacing-sm)' }}>DID / Authority Ref</th>
                        <th style={{ padding: '10px var(--spacing-sm)' }}>Max Spend Limit</th>
                        <th style={{ padding: '10px var(--spacing-sm)', textAlign: 'center' }}>Status</th>
                        <th style={{ padding: '10px var(--spacing-sm)', textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedAgents.map((agent) => {
                        const meta = agent.metadata as Record<string, unknown> | undefined;
                        const cred = meta?.delegation_credential as Record<string, unknown> | undefined;
                        const claims = (cred?.credentialSubject as Record<string, unknown> | undefined)?.["authorityClaims"] as Record<string, unknown>[] | undefined;
                        const authorityLimits = claims?.[0]?.authorityLimits as Record<string, unknown> | undefined;
                        
                        const spendLimit = authorityLimits?.maxSpendUsd 
                          ? `$${(authorityLimits.maxSpendUsd as number).toLocaleString()}` 
                          : (agent.maxNotional ? `$${parseInt(agent.maxNotional).toLocaleString()}` : 'No Limit');
                          


                        const isActive = agent.status === 'admitted';

                        return (
                          <tr key={agent.id} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.02)', transition: 'background var(--transition-fast)' }}>
                            <td style={{ padding: '12px var(--spacing-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                              {agent.label || 'Unnamed Agent'}
                            </td>
                            <td style={{ padding: '12px var(--spacing-sm)', fontFamily: 'var(--font-mono)', fontSize: '0.7rem' }}>
                              <div style={{ color: 'var(--color-text-primary)' }}>{agent.agentDid}</div>
                              <div style={{ color: 'var(--color-text-muted)', fontSize: '0.65rem', marginTop: '2px' }}>{agent.authorityRef}</div>
                            </td>
                            <td style={{ padding: '12px var(--spacing-sm)', fontFamily: 'var(--font-mono)' }}>
                              {spendLimit}
                            </td>

                            <td style={{ padding: '12px var(--spacing-sm)', textAlign: 'center' }}>
                              <span className={`status-badge ${isActive ? 'secure' : 'error'}`} style={{ display: 'inline-flex', fontSize: '0.65rem' }}>
                                {isActive ? 'ACTIVE' : 'SUSPENDED'}
                              </span>
                            </td>
                            <td style={{ padding: '12px var(--spacing-sm)', textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', gap: 'var(--spacing-xs)' }}>
                                {isActive && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleOpenEditPolicy(agent)}
                                      className="btn-grid-header-deploy"
                                      style={{ padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                      title="Edit Limit Mandates"
                                    >
                                      <Edit02Icon size={12} /> Edit Policy
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleRevoke(agent.id, agent.label || agent.id)}
                                      className="btn-grid-header-deploy"
                                      style={{ padding: '4px 8px', color: 'var(--color-error)', borderColor: 'rgba(244, 63, 94, 0.3)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                      title="Suspend trading agent"
                                    >
                                      <Delete02Icon size={12} /> Suspend
                                    </button>
                                  </>
                                )}
                                {!isActive && (
                                  <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                                    Revoked permanently
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <Pagination
                  currentPage={activePage}
                  totalPages={totalPages}
                  onPageChange={setCurrentPage}
                  totalItems={agents.length}
                  itemsPerPage={itemsPerPage}
                />
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Key Management */}
        {activeSubTab === 'keys' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', animation: 'fadeIn 0.2s ease' }}>
            <div style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--spacing-sm)' }}>
              <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>
                <Key01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Cryptographic Key Management
              </h2>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                Inspect and rotate the institution's secure payload/envelope encryption keypairs inside the enclave.
              </p>
            </div>

            {rotateSuccess && (
              <div className="status-badge secure" style={{ padding: 'var(--spacing-sm) var(--spacing-md)', fontSize: '0.75rem', justifyContent: 'flex-start', gap: '8px' }}>
                <CheckmarkCircle01Icon size={16} /> {rotateSuccess}
              </div>
            )}

            {isInstLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
                <div>
                  <Skeleton variant="text" width={150} height={14} style={{ marginBottom: 'var(--spacing-sm)' }} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
                    {[1, 2].map((i) => (
                      <div key={i} style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Skeleton variant="text" width="40%" height={14} style={{ marginBottom: 0 }} />
                          <Skeleton variant="rect" width={50} height={16} style={{ borderRadius: '4px' }} />
                        </div>
                        <Skeleton variant="text" height={12} />
                        <Skeleton variant="text" width="80%" height={12} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                          <Skeleton variant="text" width="50%" height={10} style={{ marginBottom: 0 }} />
                          <Skeleton variant="text" width="70%" height={10} style={{ marginBottom: 0 }} />
                          <Skeleton variant="text" width="60%" height={10} style={{ marginBottom: 0 }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <Skeleton variant="rect" height={100} style={{ borderRadius: 'var(--radius-md)' }} />
              </div>
            ) : instError ? (
              <div className="status-badge error" style={{ justifyContent: 'center', padding: 'var(--spacing-md)' }}>
                <AlertCircleIcon size={14} /> {instError}
              </div>
            ) : institution && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)' }}>
                
                {/* Envelope Keys Table */}
                <div>
                  <h3 style={{ fontSize: '0.8rem', color: 'var(--color-text-primary)', margin: '0 0 var(--spacing-sm) 0', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
                    Active Enclave Keys
                  </h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
                    
                    {/* Hidden Intent Encryption Key Card */}
                    <div style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>Intent Envelope Key</span>
                        <span className="status-badge secure" style={{ fontSize: '0.6rem' }}>ACTIVE</span>
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
                        Used by agents to encrypt hidden intent payloads prior to submission. Decrypted strictly inside the TEE match enclave.
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                        <div>
                          <span style={{ color: 'var(--color-text-muted)' }}>Version:</span>{' '}
                          <code style={{ color: 'var(--color-accent)' }}>
                            {(hiddenIntentKey?.keyVersion as string | undefined)?.slice(0, 32) || 'hidden_intent:static-genesis-v1'}...
                          </code>
                        </div>
                        <div>
                          <span style={{ color: 'var(--color-text-muted)' }}>Key Reference:</span>{' '}
                          <code style={{ color: 'var(--color-text-primary)' }}>
                            {(hiddenIntentKey?.publicKeyRef as string | undefined)?.slice(0, 24) || 't3-key:genesis-ref'}...
                          </code>
                        </div>
                        <div>
                          <span style={{ color: 'var(--color-text-muted)' }}>Last Rotated:</span>{' '}
                          <span style={{ color: 'var(--color-text-secondary)' }}>
                            {hiddenIntentKey?.createdAt 
                              ? new Date(hiddenIntentKey.createdAt as string).toLocaleString() 
                              : 'System Initialization'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Receipt Decryption Key Card */}
                    <div style={{ background: 'var(--color-input-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>Audit Receipt Key</span>
                        <span className="status-badge secure" style={{ fontSize: '0.6rem' }}>ACTIVE</span>
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
                        Used by matching engine to encrypt private trade logs. Decrypted by the operator console via wallet-auth key consensus.
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                        <div>
                          <span style={{ color: 'var(--color-text-muted)' }}>Version:</span>{' '}
                          <code style={{ color: 'var(--color-accent)' }}>
                            {(receiptKey?.keyVersion as string | undefined)?.slice(0, 32) || 'receipt:static-genesis-v1'}...
                          </code>
                        </div>
                        <div>
                          <span style={{ color: 'var(--color-text-muted)' }}>Key Reference:</span>{' '}
                          <code style={{ color: 'var(--color-text-primary)' }}>
                            {(receiptKey?.publicKeyRef as string | undefined)?.slice(0, 24) || 't3-key:genesis-ref'}...
                          </code>
                        </div>
                        <div>
                          <span style={{ color: 'var(--color-text-muted)' }}>Last Rotated:</span>{' '}
                          <span style={{ color: 'var(--color-text-secondary)' }}>
                            {receiptKey?.createdAt 
                              ? new Date(receiptKey.createdAt as string).toLocaleString() 
                              : 'System Initialization'}
                          </span>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>

                {/* Key Rotation Actions */}
                <div style={{ background: 'rgba(94, 210, 156, 0.02)', border: '1px solid rgba(94, 210, 156, 0.15)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-text-primary)', fontWeight: 600, fontSize: '0.8rem' }}>
                    <Shield01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Cryptographic Key Rotation Policy
                  </div>
                  <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--color-text-secondary)', lineHeight: '1.4' }}>
                    GhostBroker enclaves support cryptographic agility. If security mandates require scheduled rotations, or in the event of suspected key weakness, you can manually trigger key rotation. The secure enclave will immediately generate new AES-256-GCM envelope keys and register their digests inside the T3 network registry.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ alignSelf: 'flex-start', marginTop: 'var(--spacing-xs)', fontFamily: 'var(--font-mono)', fontSize: '0.7rem', padding: '8px 16px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    onClick={handleRotateKeys}
                    disabled={rotatingKeys}
                  >
                    {rotatingKeys ? (
                      <Loading03Icon size={12} style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <Refresh01Icon size={12} />
                    )}
                    {rotatingKeys ? 'Rotating Enclave Keys...' : 'Rotate Enclave Keys Now'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Enclave Connections */}
        {activeSubTab === 'connections' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', animation: 'fadeIn 0.2s ease' }}>
            <div style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--spacing-sm)' }}>
              <h2 className="card-title" style={{ margin: 0, border: 'none', padding: 0 }}>
                <Shield01Icon size={18} style={{ color: 'var(--color-accent)' }} /> Enclave Connection & Health
              </h2>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                Real-time connection details and attestation digests for this operator session.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
              <h3 style={{ fontSize: '0.8rem', color: 'var(--color-text-primary)', margin: 0, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>
                Secure Connection Details
              </h3>
              {enclaveError && (
                <div
                  role="alert"
                  style={{
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 'var(--spacing-sm)',
                    color: 'var(--color-text-secondary)',
                    fontSize: '0.75rem',
                  }}
                >
                  <AlertCircleIcon size={12} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                  {enclaveError}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', fontSize: '0.7rem' }}>
                <DetailRow
                  label="Tenant DID"
                  value={session.institution.t3TenantDid}
                  accent="var(--color-accent)"
                  testId="enclave-tenant-did"
                />
                <DetailRow
                  label="VC Issuer DID"
                  value={enclaveIdentity?.tenantIssuerDid ?? null}
                  isLoading={isEnclaveLoading}
                  isLoadingLabel="Resolving from TENANT_SIGNING_PRIVATE_KEY"
                  testId="enclave-issuer-did"
                />
                <DetailRow
                  label="Tenant Signing Address"
                  value={enclaveIdentity?.tenantSigningAddress ?? null}
                  isLoading={isEnclaveLoading}
                  testId="enclave-signing-address"
                />
                <DetailRow
                  label="Matching Contract"
                  value={
                    enclaveIdentity?.publishedMatchingContract
                      ? `v${enclaveIdentity.publishedMatchingContract.contractVersion} · ${enclaveIdentity.publishedMatchingContract.wasmSize.toLocaleString()} bytes · published ${new Date(enclaveIdentity.publishedMatchingContract.publishedAt).toLocaleString()}`
                      : enclaveIdentity
                        ? enclaveIdentity.matchingContractId
                          ? `${enclaveIdentity.matchingContractId} @ v${enclaveIdentity.matchingContractVersion} (env-declared; no publish record)`
                          : `not published (default v${enclaveIdentity.matchingContractVersion}; run scripts/publish-matching.ts)`
                        : null
                  }
                  {...(enclaveIdentity?.publishedMatchingContract
                    ? { accent: 'var(--color-accent)' }
                    : {})}
                  isLoading={isEnclaveLoading}
                  testId="enclave-matching-contract"
                />
                <DetailRow
                  label="T3 Network"
                  value={enclaveIdentity?.t3NetworkEnv ?? null}
                  isLoading={isEnclaveLoading}
                  testId="enclave-network-env"
                />
                <DetailRow
                  label="Attestation Handle Prefix"
                  value={enclaveIdentity?.attestationHandlePrefix ?? null}
                  isLoading={isEnclaveLoading}
                  testId="enclave-attestation-prefix"
                />
              </div>
              <p
                style={{
                  margin: 'var(--spacing-xs) 0 0 0',
                  fontSize: '0.7rem',
                  color: 'var(--color-text-muted)',
                  lineHeight: 1.5,
                }}
              >
                Tenant VC issuer DID is the <code>did:ethr:0x&hellip;</code> address derived from
                the configured <code>TENANT_SIGNING_PRIVATE_KEY</code>. The T3 SDK's
                <code> verifyEcdsaVcSig </code>
                matches this against the signer recovered from each delegation VC's
                <code> EcdsaSecp256k1Signature2019 </code>
                proof; a mismatch fails closed (see <code>terminal3-adk-onboarding-doc-gaps.md</code> T3-ONB-019).
              </p>
            </div>
          </div>
        )}

        {/* Tab 4: Settlement Profile */}
        {activeSubTab === 'settlement' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)', animation: 'fadeIn 0.2s ease' }}>
            <div style={{ borderBottom: '1px solid var(--color-border)', paddingBottom: 'var(--spacing-sm)' }}>
              <h2 className="view-title" style={{ margin: 0 }}>
                <GearIcon size={18} style={{ color: 'var(--color-accent)' }} /> Settlement Profile & Configurations
              </h2>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                Manage settlement rails, configure token addresses for Sepolia ERC-20 rails, and monitor deposit balances.
              </p>
            </div>

            <div className="status-badge" style={{ justifyContent: 'flex-start', padding: 'var(--spacing-sm) var(--spacing-md)', fontSize: '0.72rem', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', width: '100%', boxSizing: 'border-box' }}>
              <Shield01Icon size={14} /> The connected DID authenticates this console. Deposit wallet holds settlement funds; mirrored inventory reflects your connected wallet balances on Sepolia.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 'var(--spacing-lg)', width: '100%', alignItems: 'start' }}>
              <SettlementProfileCard institutionId={session.institution.id} />
              <PortfolioCard institutionId={session.institution.id} />
            </div>
          </div>
        )}

      </div>

      {/* Modal / Overlay for Editing Policy Limit Mandates */}
      {editingAgent && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          animation: 'fadeIn 0.2s ease',
        }}>
          <div className="card" style={{
            width: '500px',
            maxWidth: '90%',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-accent)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--spacing-lg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--spacing-md)',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.5)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="card-title" style={{ margin: 0, border: 'none', padding: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <GearIcon size={18} style={{ color: 'var(--color-accent)' }} /> Configure Mandate: {editingAgent.label}
              </h3>
              <button
                type="button"
                className="btn-grid-header-deploy"
                style={{ padding: '2px 6px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={() => setEditingAgent(null)}
                aria-label="Close"
              >
                <Cancel01Icon size={14} />
              </button>
            </div>
            
            <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
              Mint and cryptographically sign a new Tenant Delegation VC with revised risk bounds. The agent's next trade intents must strictly comply with these scopes.
            </p>

            {policyError && (
              <div className="status-badge error" style={{ fontSize: '0.75rem', padding: '6px 12px' }}>
                <AlertCircleIcon size={14} /> {policyError}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', fontSize: '0.75rem' }}>
              
              <div className="form-group">
                <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Max Spend Limit (USD)</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-accent)' }}>${maxSpendUsd.toLocaleString()}</span>
                </label>
                <input
                  type="number"
                  className="form-input"
                  min="1"
                  max="100000000"
                  value={maxSpendUsd}
                  onChange={(e) => setMaxSpendUsd(parseInt(e.target.value) || 0)}
                />
              </div>





            </div>

            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', justifyContent: 'flex-end', marginTop: 'var(--spacing-xs)' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditingAgent(null)}
                disabled={isSavingPolicy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontFamily: 'var(--font-mono)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                onClick={handleSavePolicy}
                disabled={isSavingPolicy}
              >
                {isSavingPolicy ? (
                  <Loading03Icon size={12} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  <CheckmarkCircle01Icon size={12} />
                )}
                {isSavingPolicy ? 'Signing & Minting...' : 'Sign & Deploy Mandate'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default SettingsPanel;
