# Dashboard Visual Verification Notes

These notes capture the visual checks and layout expectations for the GhostBroker zero-knowledge operator dashboard.

## 1. Theme and Layout Structure
- **Design Aesthetic**: Refined premium dark mode, utilizing cohesive gray/slate backgrounds with high-contrast active accents.
- **Header**: Contains the secure enclave status indicator (`SECURE` status badge) alongside the primary heading.
- **Connection Grid**: Displays institution connection states, T3 Enclave connection, and agent status. Non-operators and unauthorized agents display locked or secure status indicators without leaking names or active queue details.
- **Completed Trades Table**: Displays completed trade records. Asset Code, Quantity, and Price columns must render truncated ciphertext strings rather than plaintext. Clicking "Audit Receipt" triggers the receipt drawer.
- **Encrypted Receipt Drawer**: Slides out from the right, showing detailed receipt ciphertext, key version, and SHA-256 hash.

## 2. Privacy Checkpoints
- No active order counts or active queue size are displayed.
- The terms `bid`, `ask`, `buy`, `sell` are completely absent from active areas to prevent information leakage.
- Truncated ciphertexts use standard format helpers (e.g. `t3cipher.as...sealed` or `...phertext`) to ensure zero-visibility.
- Enclave audit disclaimer is visible at the bottom of the dashboard layout.
