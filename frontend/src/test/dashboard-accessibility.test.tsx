import { render, screen } from '@testing-library/react';
import { App } from '../app/App';
import { CompletedTradesTable } from '../components/CompletedTradesTable';
import { EncryptedReceiptDrawer } from '../components/EncryptedReceiptDrawer';
import { buildMockCompletedTrade, buildMockAuditReceipt } from './dashboard-test-data';
import { vi } from 'vitest';

// Mock the telemetry hook to return stable values
vi.mock('../hooks/useConnectionTelemetry', () => ({
  useConnectionTelemetry: () => ({
    connectionStatus: 'connected',
    enclaveStatus: 'secure',
    sandboxStatus: 'connected',
    agents: [],
    intents: [],
    errorAlert: null,
  }),
}));

// Mock trade history hook to return empty trades so it renders without throwing
vi.mock('../hooks/useTradeHistory', () => ({
  useTradeHistory: () => ({
    trades: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// Mock receipt hook
vi.mock('../hooks/useReceipt', () => ({
  useReceipt: () => ({
    receipt: null,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

describe('Dashboard Accessibility Tests', () => {
  beforeEach(() => {
    localStorage.setItem(
      'ghostbroker-auth-session',
      JSON.stringify({
        token: 'session.jwt.test',
        expiresAt: '2099-01-01T00:00:00.000Z',
        institution: {
          id: '00000000-0000-4000-8000-000000000101',
          displayName: 'Northstar Capital',
          t3TenantDid: 'did:t3:0x0000000000000000000000000000000000000301',
        },
      }),
    );
    localStorage.setItem('ghostbroker-auth-token', 'session.jwt.test');
  });

  it('renders a single h1 heading for the application title', () => {
    render(<App />);
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings.length).toBe(1);
    expect(headings[0]).toHaveTextContent(/GhostBroker/i);
  });

  it('renders CompletedTradesTable with appropriate table roles and labels', () => {
    const mockTrade = buildMockCompletedTrade();
    render(
      <CompletedTradesTable
        trades={[mockTrade]}
        isLoading={false}
        onViewReceipt={vi.fn()}
      />
    );

    const table = screen.getByRole('table', { name: /Completed Trades History/i });
    expect(table).toBeInTheDocument();

    const headers = screen.getAllByRole('columnheader');
    expect(headers.length).toBeGreaterThan(0);
  });

  it('renders EncryptedReceiptDrawer as an accessible dialog', () => {
    const mockReceipt = buildMockAuditReceipt();
    render(
      <EncryptedReceiptDrawer
        receiptId={mockReceipt.id}
        isOpen={true}
        onClose={vi.fn()}
        receipt={mockReceipt}
        isLoading={false}
        error={null}
      />
    );

    // Dialog role checks
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'drawer-title');

    // Drawer title check
    const title = screen.getByText(/Cryptographic Audit Receipt/i);
    expect(title).toBeInTheDocument();

    // Close button check
    const closeBtn = screen.getByRole('button', { name: /Close audit receipt drawer/i });
    expect(closeBtn).toBeInTheDocument();
  });
});
