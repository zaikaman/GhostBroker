/**
 * Re-export of the shared negotiation-core strategy module (formerly
 * the negotiation-core workspace, now folded into
 * `backend/src/negotiation-core/`). The backend and the hosted agent
 * CLI import the same implementation so derived rails, turn-context
 * construction, and move validation are guaranteed to be identical.
 *
 * Any new strategy math belongs in `backend/src/negotiation-core/`, not here.
 */
export * from "../negotiation-core/index.js";