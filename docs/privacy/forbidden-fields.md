# Forbidden Field Audit Checklist

Use this checklist when changing intent payloads, telemetry, logs, tests, or fixtures.

- [ ] Request bodies for `POST /api/agents/intents` contain no plaintext asset, side, quantity, or price fields.
- [ ] REST responses expose only `intentHandle` and `state`.
- [ ] WebSocket events pass through `redactTelemetryEvent`.
- [ ] Logs pass through `redactForbiddenOrderFields` or avoid request body logging entirely.
- [ ] Test fixtures use encrypted envelope placeholders only.
- [ ] Screenshots, traces, and snapshots contain no active queue, active count, price, quantity, or counterparty labels.
- [ ] New Terminal 3 adapters return opaque handles or encrypted references only.

Forbidden field names are centralized in `backend/src/privacy/forbidden-fields.ts`.
