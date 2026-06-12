1. COLOR PALETTE (Theme: Institutional Cryptographic Dark Mode)
- Primary/Background: Deep slate/charcoal (e.g., `bg-[#0B0F19]`) to represent security and the "dark pool".
- Card/Surface Background: Slightly lighter premium dark gray (e.g., `bg-[#161D2F]`) with subtle borders (`border-[#24314E]`).
- Accent Color: Muted Institutional Gold/Bronze (e.g., `text-[#C5A880]`, `bg-[#C5A880]`) to signify high-value corporate finance and luxury assets.
- Status Colors:
  * Success/Matched: Emerald green (e.g., `text-emerald-400`, `bg-emerald-500/10`)
  * Warning/Processing: Amber/Gold (e.g., `text-amber-400`, `bg-amber-500/10`)
  * Error/Denied: Crimson/Rose (e.g., `text-rose-400`, `bg-rose-500/10`)
- Typography Colors: 
  * Headings: Pure White (`text-white`)
  * Body text: Muted gray-blue (`text-slate-400`)

2. TYPOGRAPHY (Clean, high-legibility sans-serif)
- Font Family: Inter, SF Pro Display, or system-sans.
- Hierarchy:
  * H1 (Main headers): `text-2xl font-bold tracking-tight text-white`
  * H2 (Section headers): `text-lg font-semibold text-slate-200`
  * Body: `text-sm text-slate-400 leading-relaxed`
  * Monospace (For Cryptographic Hashes, Keys, DIDs, and Balances): `font-mono text-xs text-slate-300`

3. COMPONENT STYLES (Tailwind Utility Classes)
- Buttons:
  * Primary Button (Gold/Bronze): `bg-[#C5A880] hover:bg-[#B3966E] text-[#0B0F19] font-medium px-4 py-2 rounded-md transition-all text-sm`
  * Secondary Button: `border border-[#24314E] hover:bg-[#1E293B] text-slate-300 px-4 py-2 rounded-md transition-all text-sm`
- Forms & Inputs:
  * Input Fields: `bg-[#0F1524] border border-[#24314E] text-white focus:outline-none focus:border-[#C5A880] px-3 py-2 rounded-md font-mono text-sm w-full`
  * Form Labels: `text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1 block`
- Cards:
  * Container: `bg-[#161D2F] border border-[#24314E] rounded-lg p-5 shadow-xl`

4. ICONOGRAPHY (Use Lucide React or Heroicons equivalents)
- Ghost/Dark Pool: Representing hidden orders.
- Lock/Shield: Representing T3 Hardware-Secured TEE connection.
- Key: Representing Agent Auth SDK cryptographic verification.
- Terminal/Cpu: Representing autonomous AI workflow execution.

5. DASHBOARD LAYOUT REQUIREMENT
- Header: Display application name "GHOSTBROKER", global system health ("TEE Enclave: SECURE"), and the active Institution DID (e.g., `did:t3:vcb...`).
- Left Column / Main Action: "Blind Order Submission" form containing fields for Asset Ticker, Direction (BUY/SELL), Limit Price, and Volume.
- Right Column / Secure Visualization: "Sealed Order Book" section that shows an animated radar/heartbeat indicator with text: "Order queue is cryptographically sealed inside hardware TEE. Zero visibility mode active."
- Bottom Section: "Completed Trades & Audit History Table" displaying historically settled trades with clear columns for Timestamp, Asset, Side, Price, Qty, and a clickable "Verifiable Receipt" hash.