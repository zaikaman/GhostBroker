// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC20
 * @notice Minimal ERC-20 interface for the relayer's two
 * transferFrom calls. We do not import OpenZeppelin to keep the
 * contract footprint minimal — only the two methods the relayer
 * actually uses (`transferFrom`, `balanceOf`) are declared.
 */
interface IERC20 {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title GhostBrokerSettlementRelayer
 * @author GhostBroker
 * @notice The on-chain relayer for the GhostBroker dark pool's
 * settlement layer. The relayer is the party that holds
 * pre-approved ERC-20 allowances from each institution's
 * deposit address; the backend relayer account calls
 * `settle(...)` to atomically pull the asset from the buyer's
 * deposit and the payment from the seller's deposit.
 *
 * The relayer is **not** the dark-pool's settlement authority
 * — that authority is the TEE's `SettlementCommand`. The
 * relayer is the off-chain worker that actually moves the
 * assets. The on-chain `outcomeRef` is the audit-receipt
 * join key back to the TEE's opaque outcome.
 *
 * ### Idempotency
 *
 * A re-broadcast of the same `outcomeRef` reverts with
 * `OutcomeAlreadySettled`. The relayer contract is the
 * on-chain authority for dedup; the backend's
 * `dispatchCache` is a process-local optimisation, not a
 * correctness boundary. See `.hermes/plans/settlement-rails.md`
 * §3.2 for the full design.
 *
 * ### Authorization
 *
 * `settle` is restricted to the relayer account. The relayer
 * key is held in the backend's env for the v1 demo; in
 * production it is held inside the T3 tenant TEE (see
 * `docs/terminal3-adk-onboarding-doc-gaps.md`, Addendum
 * 2026-06-15).
 */
contract GhostBrokerSettlementRelayer {
    /// @notice The relayer account authorised to call `settle`.
    address public immutable relayer;

    /// @notice Tracks outcomes that have already been settled.
    /// Maps `outcomeRef` (bytes32) to `true` if a prior
    /// `settle` call with the same outcome has been mined.
    mapping(bytes32 => bool) public settledOutcomes;

    /// @notice Tracks the trade ref (TEE outcome ref) that
    /// produced each rail_trade_ref, for the WS4 reconciler.
    mapping(bytes32 => bytes32) public outcomeToRailTradeRef;

    /// @notice The exact chain tx that settled each outcome.
    /// Same key as `settledOutcomes`; stored separately so the
    /// reconciler can read a single mapping without an event
    /// scan.
    mapping(bytes32 => bytes32) public outcomeToTxHash;

    /// @notice Emitted on every successful settlement. The
    /// `outcomeRef` is the TEE's opaque outcome; the
    /// `encryptedTradeFieldsRef` is the receipt join key back
    /// to the TEE session. A chain observer sees the refs but
    /// not the plaintext trade fields.
    event Settled(
        bytes32 indexed outcomeRef,
        bytes32 encryptedTradeFieldsRef,
        address assetToken,
        uint256 assetAmount,
        address paymentToken,
        uint256 paymentAmount,
        address buyerDeposit,
        address sellerDeposit
    );

    error NotRelayer();
    error OutcomeAlreadySettled(bytes32 outcomeRef);
    error ZeroAddress();
    error TransferFailed(address token, address from, address to, uint256 amount);

    constructor(address _relayer) {
        if (_relayer == address(0)) revert ZeroAddress();
        relayer = _relayer;
    }

    /**
     * @notice Settle a match. Atomically pulls the asset from
     * the buyer's deposit and the payment from the seller's
     * deposit. Both deposit addresses must have pre-approved
     * the relayer for the respective ERC-20 tokens.
     *
     * @param outcomeRef                 TEE outcome ref; the
     *                                   canonical join key.
     * @param encryptedTradeFieldsRef    TEE receipt ref; the
     *                                   audit join key.
     * @param assetToken                 ERC-20 token for the
     *                                   asset leg (e.g. WBTC).
     * @param paymentToken               ERC-20 token for the
     *                                   payment leg (e.g.
     *                                   USDC).
     * @param buyerDeposit               Per-institution buyer
     *                                   deposit address.
     * @param sellerDeposit              Per-institution seller
     *                                   deposit address.
     * @param assetAmount                Quantity of asset
     *                                   moved (token's
     *                                   smallest unit).
     * @param paymentAmount              Quantity of payment
     *                                   moved (token's
     *                                   smallest unit).
     * @return railTradeRef              Deterministic keccak
     *                                   hash of the trade
     *                                   fields. Stored on
     *                                   `completed_trades.
     *                                   rail_trade_ref` by
     *                                   the backend.
     */
    function settle(
        bytes32 outcomeRef,
        bytes32 encryptedTradeFieldsRef,
        address assetToken,
        address paymentToken,
        address buyerDeposit,
        address sellerDeposit,
        uint256 assetAmount,
        uint256 paymentAmount
    ) external returns (bytes32 railTradeRef) {
        if (msg.sender != relayer) revert NotRelayer();
        if (settledOutcomes[outcomeRef]) revert OutcomeAlreadySettled(outcomeRef);
        if (
            assetToken == address(0) ||
            paymentToken == address(0) ||
            buyerDeposit == address(0) ||
            sellerDeposit == address(0)
        ) revert ZeroAddress();

        // Asset leg: pull the asset from the buyer's deposit
        // and send it to the seller's deposit. The buyer
        // deposit must have pre-approved the relayer for the
        // asset token.
        if (
            !IERC20(assetToken).transferFrom(
                buyerDeposit,
                sellerDeposit,
                assetAmount
            )
        ) {
            revert TransferFailed(
                assetToken,
                buyerDeposit,
                sellerDeposit,
                assetAmount
            );
        }

        // Payment leg: pull the payment asset (USDC) from
        // the seller's deposit and send it to the buyer's
        // deposit. The seller deposit must have pre-approved
        // the relayer for the payment token.
        if (
            !IERC20(paymentToken).transferFrom(
                sellerDeposit,
                buyerDeposit,
                paymentAmount
            )
        ) {
            revert TransferFailed(
                paymentToken,
                sellerDeposit,
                buyerDeposit,
                paymentAmount
            );
        }

        settledOutcomes[outcomeRef] = true;

        // railTradeRef is a deterministic keccak of the trade
        // fields. The backend stores this on the
        // `completed_trades.rail_trade_ref` column. The chain
        // observer can verify the on-chain settlement by
        // looking up this hash in the `Settled` event's
        // topic (the event is indexed by outcomeRef, not by
        // railTradeRef, so the reconciler must read the
        // tx receipt and find the matching log).
        railTradeRef = keccak256(
            abi.encode(
                outcomeRef,
                assetToken,
                paymentToken,
                buyerDeposit,
                sellerDeposit,
                assetAmount,
                paymentAmount
            )
        );
        outcomeToRailTradeRef[outcomeRef] = railTradeRef;
        outcomeToTxHash[outcomeRef] = bytes32(uint256(uint160(address(this))));
        // The above `outcomeToTxHash` line stores the relayer
        // contract's own address as a placeholder; the
        // reconciler reads the actual tx hash from the
        // receipt's `transactionHash` field. The mapping is
        // reserved for the WS4 enhancement that scans chain
        // events for `Settled` and back-fills the real tx
        // hash.

        emit Settled(
            outcomeRef,
            encryptedTradeFieldsRef,
            assetToken,
            assetAmount,
            paymentToken,
            paymentAmount,
            buyerDeposit,
            sellerDeposit
        );
    }

    /**
     * @notice Reverse a prior settlement. Pulls the asset
     * back from the seller's deposit and returns it to the
     * buyer's deposit, then pulls the payment back from the
     * buyer's deposit and returns it to the seller's
     * deposit. The relayer must have pre-approved allowances
     * for the *reverse* direction (production: the relayer
     * does not need allowances for the reverse, because the
     * tokens it just received are already in the
     * counterparty's deposit; the relayer only needs
     * approval to `transferFrom` them back).
     *
     * For the v1 demo, the relayer's `transferFrom` calls in
     * the reverse direction require the **counterparty** to
     * have approved the relayer at deposit time. WS2.5
     * production path: use `transfer` (relayer holds the
     * tokens after the original settle) so the reverse is
     * unconditional. v1 keeps `transferFrom` for symmetry
     * with the forward path and surfaces the error if the
     * counterparty has not approved.
     *
     * Idempotency: a second reverse on the same outcome
     * reverts with `OutcomeNotSettled` is not appropriate
     * here; instead the contract tracks `reversedOutcomes`
     * to prevent double-reverse.
     */
    mapping(bytes32 => bool) public reversedOutcomes;

    error AlreadyReversed(bytes32 outcomeRef);
    error NotSettled(bytes32 outcomeRef);

    function reverse(
        bytes32 outcomeRef,
        bytes32 encryptedTradeFieldsRef,
        address assetToken,
        address paymentToken,
        address buyerDeposit,
        address sellerDeposit,
        uint256 assetAmount,
        uint256 paymentAmount
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (!settledOutcomes[outcomeRef]) revert NotSettled(outcomeRef);
        if (reversedOutcomes[outcomeRef]) revert AlreadyReversed(outcomeRef);

        // Reverse the asset leg: pull the asset from the
        // seller's deposit (where the forward settle put it)
        // and send it back to the buyer's deposit.
        if (
            !IERC20(assetToken).transferFrom(
                sellerDeposit,
                buyerDeposit,
                assetAmount
            )
        ) {
            revert TransferFailed(
                assetToken,
                sellerDeposit,
                buyerDeposit,
                assetAmount
            );
        }

        // Reverse the payment leg: pull the payment from the
        // buyer's deposit and return it to the seller's
        // deposit.
        if (
            !IERC20(paymentToken).transferFrom(
                buyerDeposit,
                sellerDeposit,
                paymentAmount
            )
        ) {
            revert TransferFailed(
                paymentToken,
                buyerDeposit,
                sellerDeposit,
                paymentAmount
            );
        }

        reversedOutcomes[outcomeRef] = true;

        emit Settled(
            outcomeRef,
            encryptedTradeFieldsRef,
            assetToken,
            assetAmount,
            paymentToken,
            paymentAmount,
            sellerDeposit,
            buyerDeposit
        );
    }
}
