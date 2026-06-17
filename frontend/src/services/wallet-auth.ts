import { apiClient, type AuthSession } from './api-client';

declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
    };
  }
}

export interface WalletAuthResult {
  session: AuthSession;
  address?: string;
}

function walletAddressToDid(address: string): string {
  return `did:t3:${address.toLowerCase()}`;
}

export async function connectWithWallet(): Promise<WalletAuthResult> {
  if (!window.ethereum) {
    throw new Error('No Web3 wallet provider was detected.');
  }

  const accounts = await window.ethereum.request<string[]>({
    method: 'eth_requestAccounts',
  });
  const address = accounts[0]?.toLowerCase();

  if (!address) {
    throw new Error('Wallet connection did not return an account.');
  }

  const did = walletAddressToDid(address);
  const challenge = await apiClient.requestAuthChallenge(did);
  const signature = await window.ethereum.request<string>({
    method: 'personal_sign',
    params: [challenge.challenge, address],
  });
  const session = await apiClient.verifyAuthChallenge(
    challenge.challengeId,
    signature,
  );

  return { session, address };
}

