declare global {
  interface Window {
    ethereum?: {
      request<T = unknown>(args: { method: string; params?: unknown[] }): Promise<T>;
    };
  }
}

export type DepositAsset = 'ETH' | 'WBTC' | 'USDC';

export interface DepositAssetConfig {
  symbol: string;
  decimals: number;
  tokenAddress?: string;
}

export interface DepositWithWalletRequest {
  asset: DepositAsset;
  amount: string;
  depositAddress: string;
  assetConfig: DepositAssetConfig;
}

export interface DepositWithWalletResult {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  asset: DepositAsset;
  amount: string;
}

const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';
const SEPOLIA_CHAIN_ID_DEC = 11155111;
const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

function ensureProvider() {
  if (!window.ethereum) {
    throw new Error('No Web3 wallet provider was detected.');
  }
  return window.ethereum;
}

function ensurePositiveDecimal(value: string): void {
  if (!/^\d+(\.\d+)?$/u.test(value) || Number(value) <= 0) {
    throw new Error('Deposit amount must be a positive decimal string.');
  }
}

function parseUnits(value: string, decimals: number): bigint {
  ensurePositiveDecimal(value);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Too many decimal places for this asset. Max is ${decimals}.`);
  }
  const paddedFraction = fraction.padEnd(decimals, '0');
  const normalized = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/u, '');
  return BigInt(normalized || '0');
}

function toHexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function encodeAddress(address: string): string {
  const normalized = address.toLowerCase().replace(/^0x/u, '');
  return normalized.padStart(64, '0');
}

function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

async function ensureSepolia(provider: NonNullable<Window['ethereum']>): Promise<void> {
  const currentChainId = await provider.request<string>({ method: 'eth_chainId' });
  if (currentChainId?.toLowerCase() === SEPOLIA_CHAIN_ID_HEX) {
    return;
  }

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
    });
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: number }).code : undefined;
    if (code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: SEPOLIA_CHAIN_ID_HEX,
          chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        }],
      });
      return;
    }
    throw error;
  }
}

export async function depositWithWallet(
  request: DepositWithWalletRequest,
): Promise<DepositWithWalletResult> {
  if (!ADDRESS_RE.test(request.depositAddress)) {
    throw new Error('Deposit address must be a valid 0x wallet address.');
  }

  const provider = ensureProvider();
  const accounts = await provider.request<string[]>({ method: 'eth_requestAccounts' });
  const fromAddress = accounts[0];
  if (!fromAddress || !ADDRESS_RE.test(fromAddress)) {
    throw new Error('Wallet connection did not return a valid account.');
  }

  await ensureSepolia(provider);

  let txHash: string;
  if (request.asset === 'ETH') {
    const value = parseUnits(request.amount, 18);
    txHash = await provider.request<string>({
      method: 'eth_sendTransaction',
      params: [{
        from: fromAddress,
        to: request.depositAddress,
        value: toHexQuantity(value),
        chainId: toHexQuantity(BigInt(SEPOLIA_CHAIN_ID_DEC)),
      }],
    });
  } else {
    if (!request.assetConfig.tokenAddress || !ADDRESS_RE.test(request.assetConfig.tokenAddress)) {
      throw new Error(`Missing token address for ${request.asset}.`);
    }
    const amount = parseUnits(request.amount, request.assetConfig.decimals);
    const data = `${ERC20_TRANSFER_SELECTOR}${encodeAddress(request.depositAddress)}${encodeUint256(amount)}`;
    txHash = await provider.request<string>({
      method: 'eth_sendTransaction',
      params: [{
        from: fromAddress,
        to: request.assetConfig.tokenAddress,
        data,
        chainId: toHexQuantity(BigInt(SEPOLIA_CHAIN_ID_DEC)),
      }],
    });
  }

  return {
    txHash,
    fromAddress,
    toAddress: request.depositAddress,
    asset: request.asset,
    amount: request.amount,
  };
}
