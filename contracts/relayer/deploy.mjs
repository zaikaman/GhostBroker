/**
 * Deploy GhostBrokerSettlementRelayer to Sepolia.
 * Usage: node deploy.mjs
 * Reads SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL and
 * SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY from backend/.env
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, "../../backend/.env");
const envFile = readFileSync(envPath, "utf-8");
function readEnv(key) {
  const match = envFile.match(new RegExp("^" + key + "=(.+)$", "m"));
  if (!match) throw new Error("Missing " + key + " in " + envPath);
  const v = match[1].trim();
  return v;
}

const rpcUrl = readEnv("SETTLEMENT_RAIL_CHAIN_SEPOLIA_RPC_URL");
const rawKey = readEnv("SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_PRIVATE_KEY");
const relayerPrivateKey = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;

const account = privateKeyToAccount(relayerPrivateKey);
console.log("Relayer address (constructor arg): " + account.address);

const artifactPath = resolve(__dirname, "out/GhostBrokerSettlementRelayer.sol/GhostBrokerSettlementRelayer.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
const bytecode = artifact.bytecode.object;
const abi = artifact.abi;

const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain: sepolia, transport: http(rpcUrl), account });

console.log("Deploying GhostBrokerSettlementRelayer...");
const hash = await walletClient.deployContract({ abi, bytecode, args: [account.address] });
console.log("Deploy tx hash: " + hash);
console.log("Waiting for confirmation...");
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log("\nContract deployed!");
console.log("Address: " + receipt.contractAddress);
console.log("Block:   " + receipt.blockNumber);
console.log("\nAdd this to your backend/.env:");
console.log("SETTLEMENT_RAIL_CHAIN_SEPOLIA_RELAYER_CONTRACT_ADDRESS=" + receipt.contractAddress);
