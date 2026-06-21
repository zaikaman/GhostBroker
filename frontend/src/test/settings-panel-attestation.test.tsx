import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../components/SettingsPanel';
import { apiClient } from '../services/api-client';
import type * as ApiClientModule from '../services/api-client';

vi.mock('../services/api-client', async () => {
  const actual =
    await vi.importActual<typeof ApiClientModule>('../services/api-client');
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      listAgents: vi.fn().mockResolvedValue([]),
      getInstitution: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000101',
        legalName: 'Northstar Capital LLC',
        displayName: 'Northstar Capital',
        status: 'active',
        t3TenantDid: 'did:t3n:0x0000000000000000000000000000000000000301',
        settlementProfileRef: 'chain:sepolia:erc20',
        metadata: {},
      }),
      getEnclaveIdentity: vi.fn().mockResolvedValue({
        t3NetworkEnv: 'testnet',
        t3TenantDid: 'did:t3n:0x0000000000000000000000000000000000000301',
        matchingContractId: null,
        matchingContractVersion: '0.9.1',
        tenantSigningAddress: '0x0000000000000000000000000000000000000301',
        tenantIssuerDid: 'did:ethr:0x0000000000000000000000000000000000000301',
        attestationHandlePrefix: 't3attest:',
        publishedMatchingContract: null,
      }),
      getEnclaveAttestation: vi.fn(),
    },
  };
});

const mockedGetEnclaveAttestation = vi.mocked(apiClient.getEnclaveAttestation);

const session = {
  institution: {
    id: '00000000-0000-4000-8000-000000000101',
    displayName: 'Northstar Capital',
    t3TenantDid: 'did:t3n:0x0000000000000000000000000000000000000301',
  },
};

async function openEnclaveConnectionTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Enclave Connection/i }));
}

describe('SettingsPanel — Verify TEE Attestation', () => {
  beforeEach(() => {
    mockedGetEnclaveAttestation.mockReset();
  });

  it('renders the Verify TEE Attestation button in the Enclave Connection panel', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel session={session} />);
    await openEnclaveConnectionTab(user);

    expect(
      await screen.findByRole('button', { name: /Verify TEE Attestation/i }),
    ).toBeInTheDocument();
  });

  it('fetches and renders the TEE-issued attestation quote on a verified probe', async () => {
    mockedGetEnclaveAttestation.mockResolvedValue({
      verified: true,
      probedAt: '2026-06-21T17:00:00.000Z',
      networkEnv: 'testnet',
      contractVersion: '0.9.1',
      publishedMatchingContract: {
        tail: 'matching',
        contractVersion: '0.9.1',
        publishedAt: '2026-06-20T10:00:00.000Z',
        tenantDid: 'did:t3n:0x0000000000000000000000000000000000000301',
        networkEnv: 'testnet',
        wasmSize: 190000,
      },
      teeResponse: {
        intentHandle: 'intent_abc123',
        executionRef: 't3exec_xyz',
        attestationRef: 't3attest:seal_abc123',
        responseStatus: 200,
      },
      error: null,
    });

    const user = userEvent.setup();
    render(<SettingsPanel session={session} />);
    await openEnclaveConnectionTab(user);

    const button = await screen.findByRole('button', { name: /Verify TEE Attestation/i });
    await user.click(button);

    expect(await screen.findByTestId('enclave-attestation-quote')).toBeInTheDocument();
    expect(screen.getByText(/TEE Verified/i)).toBeInTheDocument();
    expect(screen.getByTestId('attestation-intent-handle')).toHaveTextContent(
      /intent_abc123/,
    );
    expect(screen.getByTestId('attestation-ref')).toHaveTextContent(
      /t3attest:seal_abc123/,
    );
    expect(mockedGetEnclaveAttestation).toHaveBeenCalledTimes(1);
  });

  it('renders a verification-failed state when the probe is not verified', async () => {
    mockedGetEnclaveAttestation.mockResolvedValue({
      verified: false,
      probedAt: '2026-06-21T17:00:00.000Z',
      networkEnv: 'testnet',
      contractVersion: '0.9.1',
      publishedMatchingContract: null,
      teeResponse: null,
      error: "T3N tenant contract 'matching' is not registered (HTTP 404).",
    });

    const user = userEvent.setup();
    render(<SettingsPanel session={session} />);
    await openEnclaveConnectionTab(user);

    const button = await screen.findByRole('button', { name: /Verify TEE Attestation/i });
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText(/Verification Failed/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/not registered/i),
    ).toBeInTheDocument();
  });

  it('surfaces a fetch error without crashing', async () => {
    mockedGetEnclaveAttestation.mockRejectedValue(new Error('network down'));

    const user = userEvent.setup();
    render(<SettingsPanel session={session} />);
    await openEnclaveConnectionTab(user);

    const button = await screen.findByRole('button', { name: /Verify TEE Attestation/i });
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/network down/i);
    });
  });
});
