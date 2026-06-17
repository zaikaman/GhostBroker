/**
 * Re-export of the shared `@ghostbroker/negotiation-core` strategy
 * module. The backend and the hosted agent runtime import the same
 * implementation so derived rails, turn-context construction, and
 * move validation are guaranteed to be identical.
 *
 * Any new strategy math belongs in the shared package, not here.
 */
export * from "@ghostbroker/negotiation-core";