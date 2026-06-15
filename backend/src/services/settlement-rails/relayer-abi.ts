/**
 * Loader for the GhostBroker on-chain settlement relayer ABI
 * and bytecode.
 *
 * The source Solidity contract lives at
 * `contracts/relayer/src/contracts/GhostBrokerSettlementRelayer.sol`
 * and is compiled with Forge. The compiled artifact (the
 * standard Foundry `combined-json` output) is copied to this
 * directory at build time by the
 * `contracts/package.json#build:relayer:copy-abi` script.
 *
 * This file imports the JSON artifact and re-exports a
 * `RelayerContractAbi` constant typed as `Abi` (viem). The
 * chain rail constructs a viem `walletClient.writeContract`
 * call against this ABI to broadcast `settle(...)` and
 * `reverse(...)`.
 *
 * **Build pipeline:**
 *   1. `cd contracts/relayer && forge build`  — compiles
 *      Solidity, produces
 *      `out/GhostBrokerSettlementRelayer.sol/GhostBrokerSettlementRelayer.json`.
 *   2. `cd contracts && npm run build:relayer:copy-abi`
 *      — copies the artifact into
 *      `backend/src/services/settlement-rails/abi/`.
 *
 * **Type safety:** The JSON is committed to the repo as a
 * blob, but the `as const` cast narrows the shape to a
 * readonly tuple. viem accepts the `Abi` type for
 * `writeContract` and validates the call against the runtime
 * type info.
 */
import relayerArtifactJson from "./abi/GhostBrokerSettlementRelayer.json" with { type: "json" };
import erc20ArtifactJson from "./abi/MinimalERC20.json" with { type: "json" };
import type { Abi } from "viem";

/**
 * The relayer contract's ABI, typed for viem's
 * `writeContract` and `readContract` overloads.
 */
export const RelayerContractAbi = relayerArtifactJson.abi as unknown as Abi;

/**
 * The relayer contract's creation bytecode. Used by the
 * Anvil integration test to deploy a fresh relayer per run.
 */
export const RelayerContractBytecode =
  relayerArtifactJson.bytecode.object as `0x${string}`;

/**
 * The relayer contract's deployed (runtime) bytecode.
 * Useful for `eth_getCode` assertions in tests.
 */
export const RelayerContractDeployedBytecode =
  relayerArtifactJson.deployedBytecode.object as `0x${string}`;

/**
 * The minimal ERC-20 ABI used by the Anvil integration test
 * to deploy an asset token and a payment token. NOT intended
 * for production — production uses audited OpenZeppelin
 * ERC-20 contracts on Sepolia.
 */
export const MinimalErc20Abi = erc20ArtifactJson.abi as unknown as Abi;

/**
 * The minimal ERC-20 creation bytecode.
 */
export const MinimalErc20Bytecode =
  erc20ArtifactJson.bytecode.object as `0x${string}`;

