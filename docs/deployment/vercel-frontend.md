# Vercel Frontend Deployment Notes

This document provides deployment guidelines for deploying the GhostBroker operator dashboard frontend workspace to Vercel.

## Environment Variables
The following environment variables must be configured in the Vercel dashboard settings:

| Name | Type | Value / Purpose |
|------|------|-----------------|
| `VITE_API_BASE_URL` | Plaintext | The backend endpoint base URL (e.g., `https://ghostbroker-backend.herokuapp.com`). |
| `VITE_WS_TELEMETRY_URL` | Plaintext | The secure telemetry WebSocket endpoint (e.g., `wss://ghostbroker-backend.herokuapp.com/ws/telemetry`). |

## Build and Deployment Settings
1. **Framework Preset**: Vite / Other (Auto-detected).
2. **Root Directory**: `frontend`.
3. **Build Command**: `npm run build`.
4. **Output Directory**: `dist`.

## Verification Steps
Once the build completes, visit the Vercel deployment URL and verify that the secure connection state successfully updates and queries the live backend endpoints.
