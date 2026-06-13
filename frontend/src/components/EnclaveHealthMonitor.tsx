import React, { useState, useEffect } from 'react';
import {
  CpuIcon,
  Shield01Icon,
  Activity01Icon,
  Clock01Icon,
  CheckmarkCircle01Icon
} from 'hugeicons-react';

export function EnclaveHealthMonitor(): React.JSX.Element {
  const [cpuLoad, setCpuLoad] = useState<number>(3.8);
  const [epcUsed, setEpcUsed] = useState<number>(41.2);
  const [latency, setLatency] = useState<number>(3.42);
  const [msgRate, setMsgRate] = useState<number>(2.4);
  const [networkPing, setNetworkPing] = useState<number>(18);
  const [uptime, setUptime] = useState<string>('00:00:00');

  useEffect(() => {
    // Timer for uptime
    const startTime = Date.now();
    const uptimeInterval = setInterval(() => {
      const diff = Date.now() - startTime;
      const hours = Math.floor(diff / 3600000).toString().padStart(2, '0');
      const minutes = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
      const seconds = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
      setUptime(`${hours}:${minutes}:${seconds}`);
    }, 1000);

    // Interval to simulate hardware metrics fluctuating slightly
    const metricsInterval = setInterval(() => {
      setCpuLoad((prev) => {
        const delta = (Math.random() - 0.5) * 0.8;
        return Math.min(Math.max(parseFloat((prev + delta).toFixed(1)), 1.2), 12.5);
      });
      setEpcUsed((prev) => {
        const delta = (Math.random() - 0.5) * 0.3;
        return Math.min(Math.max(parseFloat((prev + delta).toFixed(2)), 39.5), 45.8);
      });
      setLatency((prev) => {
        const delta = (Math.random() - 0.5) * 0.15;
        return Math.min(Math.max(parseFloat((prev + delta).toFixed(2)), 2.85), 4.25);
      });
      setMsgRate((prev) => {
        const delta = (Math.random() - 0.5) * 0.4;
        return Math.min(Math.max(parseFloat((prev + delta).toFixed(1)), 0.5), 6.8);
      });
      setNetworkPing((prev) => {
        const delta = Math.floor((Math.random() - 0.5) * 3);
        return Math.min(Math.max(prev + delta, 12), 26);
      });
    }, 3000);

    return () => {
      clearInterval(uptimeInterval);
      clearInterval(metricsInterval);
    };
  }, []);

  const epcMax = 128.0; // Standard SGX Enclave Page Cache limit
  const epcPercentage = ((epcUsed / epcMax) * 100).toFixed(1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
      <h3 className="form-label" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Activity01Icon size={16} style={{ color: 'var(--color-accent)' }} /> Enclave Health & Telemetry
      </h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
        {/* Status Row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 'var(--spacing-sm)', borderBottom: '1px solid rgba(255, 255, 255, 0.03)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>SECURITY STATE</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
              <Shield01Icon size={14} style={{ color: 'var(--color-accent)' }} /> Intel SGX TEE Active
            </span>
          </div>
          <span className="status-badge secure" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.7rem' }}>
            <CheckmarkCircle01Icon size={10} /> ATTESTED
          </span>
        </div>

        {/* EPC Memory Progress Bar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>SGX EPC MEMORY</span>
            <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{epcUsed} MB / {epcMax} MB ({epcPercentage}%)</span>
          </div>
          <div style={{ height: '6px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{ width: `${epcPercentage}%`, height: '100%', background: 'var(--color-accent)', borderRadius: '3px', transition: 'width var(--transition-normal)' }}></div>
          </div>
        </div>

        {/* Hardware Statistics Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-sm)' }}>
          <div style={{ background: 'var(--color-input-bg)', padding: 'var(--spacing-sm)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <CpuIcon size={12} /> CPU CORE LOAD
            </span>
            <span style={{ fontSize: '1.1rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>
              {cpuLoad}%
            </span>
          </div>

          <div style={{ background: 'var(--color-input-bg)', padding: 'var(--spacing-sm)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock01Icon size={12} /> EXEC LATENCY
            </span>
            <span style={{ fontSize: '1.1rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>
              {latency} ms
            </span>
          </div>

          <div style={{ background: 'var(--color-input-bg)', padding: 'var(--spacing-sm)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Activity01Icon size={12} /> TELEMETRY RATE
            </span>
            <span style={{ fontSize: '1.1rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>
              {msgRate} msg/s
            </span>
          </div>

          <div style={{ background: 'var(--color-input-bg)', padding: 'var(--spacing-sm)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock01Icon size={12} /> BROKER LATENCY
            </span>
            <span style={{ fontSize: '1.1rem', fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)' }}>
              {networkPing} ms
            </span>
          </div>
        </div>

        {/* Footer/Compliance Attestation Information */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', paddingTop: 'var(--spacing-xs)' }}>
          <span>UPTIME: {uptime}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ display: 'inline-block', width: '6px', height: '6px', background: 'var(--color-accent)', borderRadius: '50%' }}></span>
            LEAK PREVENTION ACTIVE
          </span>
        </div>
      </div>
    </div>
  );
}

export default EnclaveHealthMonitor;
