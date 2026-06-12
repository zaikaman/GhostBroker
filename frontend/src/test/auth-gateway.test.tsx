import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AuthGateway } from '../components/AuthGateway';

const connectWithWalletMock = vi.hoisted(() => vi.fn());

vi.mock('../services/wallet-auth', () => ({
  connectWithWallet: connectWithWalletMock,
}));

describe('AuthGateway', () => {
  it('connects a Web3 wallet and authenticates on success', async () => {
    const user = userEvent.setup();
    const session = {
      token: 'session.jwt.ui',
      expiresAt: '2026-06-12T20:00:00.000Z',
      institution: {
        id: '00000000-0000-4000-8000-000000000101',
        displayName: 'Northstar Capital',
        t3TenantDid: 'did:t3:0x0000000000000000000000000000000000000301',
      },
    };
    connectWithWalletMock.mockResolvedValueOnce({ session });

    const onAuthenticated = vi.fn();
    render(<AuthGateway onAuthenticated={onAuthenticated} />);

    await user.click(screen.getByRole('button', { name: /Connect Web3 Wallet/i }));

    expect(connectWithWalletMock).toHaveBeenCalledTimes(1);
    expect(onAuthenticated).toHaveBeenCalledWith(session);
  });

  it('shows an error message when wallet connection fails', async () => {
    const user = userEvent.setup();
    connectWithWalletMock.mockRejectedValueOnce(new Error('User rejected request.'));

    const onAuthenticated = vi.fn();
    render(<AuthGateway onAuthenticated={onAuthenticated} />);

    await user.click(screen.getByRole('button', { name: /Connect Web3 Wallet/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('User rejected request.');
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});
