okay, back to English, generate me a complete user flow diagram of this app

Here is the complete end-to-end user and data flow diagram for GhostBroker. This layout maps how actions on the React frontend securely trigger cryptographic workflows across your Express backend, the Terminal 3 TEE Enclave, and Supabase.

📊 GhostBroker End-to-End System Flow
Plaintext
       [ ENTERPRISE USER / INSTITUTION ]
                       │
                       │ 1. Navigates to Platform & Logs In
                       ▼
             ┌───────────────────┐
             │  React Frontend   │ ◄──────────────────────────────────┐
             └─────────┬─────────┘                                    │
                       │                                              │
                       │ 2. Initiates Secure Agent Handshake          │
                       ▼                                              │
             ┌───────────────────┐                                    │
             │  Express Backend  │                                    │
             └─────────┬─────────┘                                    │
                       │                                              │ 11. Real-time Telemetry
                       │ 3. Instantiates T3 Runner & Generates Session│     via WebSockets
                       ▼                                              │     (Masked Data Only)
        ┌─────────────────────────────┐                               │
        │ Terminal 3 TEE Enclave      │                               │
        │  (Hardware-Secured Context) │                               │
        └──────────────┬──────────────┘                               │
                       │                                              │
                       │ 4. Verifies Identity & Returns Confirmed DID │
                       ▼                                              │
             ┌───────────────────┐                                    │
             │   Supabase DB     │ ── 5. Verifies Corporate Account ──┘
             └───────────────────┘
📥 1. Order Placement & Encryption Lifecycle
Plaintext
[ Institutional Trader ]
          │
          │ Input fields: Asset, Side, Volume, Max/Min Limit Price
          ▼
┌──────────────────────────────────────┐
│ React Frontend UI                    │
└──────────────────┬───────────────────┘
                   │
                   │ 1. Submits Order Form
                   ▼
┌──────────────────────────────────────┐
│ Express Server Gateway               │
└──────────────────┬───────────────────┘
                   │
                   │ 2. Strips routing data; Pipes parameters directly
                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Terminal 3 TEE Enclave (Isolated Runtime Memory)                        │
│                                                                        │
│  [ Encrypt Ingress ] ──► Parameters converted to cryptographic cipher   │
│                                                                        │
│  [ In-Memory Matching Matrix ]                                         │
│       ▲                                                                │
│       │ 3. Places Hidden Order into Blind Priority Queue               │
│       ▼                                                                │
│  ┌─────────────────────────┐     No Match Detected                     │
│  │ Does Buy Price ≥ Sell?  │ ────────────────────────────────────────┐ │
│  └───────────┬─────────────┘                                         │ │
│              │                                                       │ │
│              │ Yes (Match Confirmed)                                 │ │
│              ▼                                                       ▼ │
│  [ Trigger Atomic Settlement ]                         [ Retain Hidden State ]
└──────────────┬───────────────────────────────────────────────────────┘
               │
               │ 4. Clear memory loop variables
               ▼
   ( Proceeds to Clearing Lifecycle )
💸 2. Settlement, Ledger Writing & Audit Logging
Plaintext
┌─────────────────────────────────────────────────────────┐
│ Terminal 3 TEE Enclave (Internal Settled Match Context) │
└────────────────────────────┬────────────────────────────┘
                             │
                             │ 1. Requests Balance Changes on Sandbox Assets
                             ▼
              ┌─────────────────────────────┐
              │  Terminal 3 Sandbox Network │
              └──────────────┬──────────────┘
                             │
                             │ 2. Processes Atomic Token Swap & Emits TX Hash
                             ▼
              ┌─────────────────────────────┐
              │   Express Server Broker     │
              └──────────────┬──────────────┘
                             │
                             │ 3. Constructs Relational Payloads
                             ▼
              ┌─────────────────────────────┐
              │        Supabase DB          │
              └──────┬───────────────┬──────┘
                     │               │
  4a. Write Base Log │               │ 4b. Write Encrypted Enclave Signature
                     ▼               ▼
      ┌──────────────────────┐   ┌─────────────────────────────────────┐
      │  completed_trades    │   │  audit_receipts                     │
      │                      │   │                                     │
      │ ── buy_inst_id       │   │ ── trade_id                         │
      │ ── sell_inst_id      │   │ ── encrypted_payload (JSONB)         │
      │ ── asset_ticker      │   │ ── signature (Ed25519 Enclave Sign) │
      │ ── clearing_price    │   └─────────────────────────────────────┘
      │ ── settlement_hash   │
      └──────────────────────┘
🖥️ 3. Frontend Visualization Hierarchy
Plaintext
┌───────────────────────────────────────────────────────────────────────────┐
│                          GHOSTBROKER BOARD UI                             │
├───────────────────────────────────────────────────────────────────────────┤
│ [CONNECTED DID: did:t3:0x4f... ]                 [ TEE HEARTBEAT: SECURE ]│
├─────────────────────────────────────┬─────────────────────────────────────┤
│                                     │                                     │
│  BLIND ORDER SUBMISSION FORM        │      SEALED ORDER BOOK MONITOR      │
│                                     │                                     │
│  Asset Ticker: [ BTC          ]     │  ┌───────────────────────────────┐  │
│  Side:         [ BUY  ][ SELL ]     │  │ ⚡ ENCLAVE MATRIX OPERATIONAL │  │
│  Limit Price:  [ $ 70,000     ]     │  │ ───────────────────────────── │  │
│  Volume (Qty): [ 10           ]     │  │ [17:42:01] Ingress Scanned    │  │
│                                     │  │ [17:42:01] Payload Shielded   │  │
│  ┌───────────────────────────────┐  │  │ [17:43:10] Scanning Queue...  │  │
│  │     PLACE HIDDEN ORDER        │  │  │ [17:45:22] MATCH DISCOVERED   │  │
│  └───────────────────────────────┘  │  └───────────────────────────────┘  │
│                                     │                                     │
├─────────────────────────────────────┴─────────────────────────────────────┤
│                                                                           │
│  COMPLETED TRADES & AUDIT LEDGER (DECRYPTED LOCAL-ONLY)                    │
│  ┌───────────┬─────────┬───────┬─────────────┬──────────┬──────────────┐  │
│  │ Timestamp │ Asset   │ Side  │ Price (T3T) │ Qty      │ Audit Proof  │  │
│  ├───────────┼─────────┼───────┼─────────────┼──────────┼──────────────┤  │
│  │ 17:45:22  │ BTC     │ BUY   │ $69,500.00  │ 10.00    │ [View Tx] ↗  │  │
│  └───────────┴─────────┴───────┴─────────────┴──────────┴──────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
💡 Design Note for implementation via Spec-Kit:
When your coding agent generates the WebSocket channel logic in frontend-ui/src/services/websocket.js, make sure it passes only timestamps and status string updates—never include structural variables holding order arrays or price properties in the server-to-client broadcast loop. This maintains a true zero-visibility model until the trade is closed and settled.

okay, what's the best way to login? Using email and OTP? Is that okay? Like enter email, receive an OTP code, verify the OTP and submit and login, is that okay?

For a generic SaaS application, email and OTP is perfectly fine. But for GhostBroker in this specific hackathon, it will likely cost you the win.

Remember, 40% of your score is based on "How well integrated is the Agent Auth SDK in its entirety." If you use a basic Web2 email + OTP flow to log a user in, you are missing a massive opportunity to use Terminal 3’s core tech where it belongs. Looking at top-tier projects currently building on Terminal 3's infrastructure, the judges want to see decentralized identity, cryptographic handshakes, and verifiable credentials.

Here is why email/OTP falls short here, and how you should structure the authentication flow to secure maximum points.

⚠️ Why Email + OTP Is a Missed Opportunity
It's Web2-centric: Large banks and institutions trading in dark pools do not use email OTPs to authenticate high-value transactions. They use hard cryptographic keys.

It leaves the SDK out of the gateway: If the first thing a judge sees is an Email/OTP screen, it looks like a standard web app that just tacked on the SDK later.

It doesn't establish the Agent Context: For your agent to act on behalf of the institution inside the TEE, it needs to verify a decentralized identity right at the front door.

🏆 The Winning Way: Web3/DID Authentication
Instead of logging into an account, the user should authorize their autonomous trading agent using their Terminal 3 Decentralized Identifier (DID) or Web3 wallet.

Here is the step-by-step institutional flow that will impress the judges:

The Authentication Flow
The Handshake Request: On the frontend, the user enters their institutional ID or connects their Web3 wallet (representing their Terminal 3 DID, e.g., did:t3:0xFinancialInstitution).

The Cryptographic Challenge: The Node.js backend generates a unique, one-time cryptographic challenge string (a nonce).

The SDK Signing: The client signs this challenge using their private key via the Terminal 3 Agent Auth SDK (proving they own that DID).

The TEE Verification: The backend pipes this signed payload into the simulated T3 TEE context using verifyAgentIdentity(). The enclave verifies the signature and confirms the identity is valid.

Session Establishment: Once validated, Supabase matches the verified DID to the institutional record (institutions table) and returns a JWT session token to the frontend.

💡 How to Pivot (If you still want simplicity)
If you really want to keep an email-like flow because it's easier to build quickly for a hackathon, you can adapt it to fit the criteria by making it a "Verifiable Credential Email Verification":

The Workflow: The user inputs their corporate email (trader@goldmansachs.com).

The Twist: Instead of a simple Web2 OTP code check, the backend issues a Verifiable Credential (VC) to that email address stating "This user is an authorized trader for Goldman Sachs."

The Integration: The user's AI Agent presents this VC to the Terminal 3 Agent Auth SDK to gain entrance into the GhostBroker Dark Pool.

Why this change matters:
By framing it as a Verifiable Credential verification rather than a standard Firebase/Supabase OTP table check, you turn a basic feature into a showcase of Terminal 3's selective-disclosure capabilities. It makes your solution look completely cohesive to the judges.

okay, i looked at your diagrams and i dont see the agents doing anything

You are completely right to point that out. The previous diagram showed the high-level infrastructure, but it left out the most important part: the conversational and autonomous nature of the Agent Dev Kit (ADK).

According to the Terminal 3 documentation, the ADK isn't just an API—it runs an actual Agent Loop where an autonomous agent manages a conversational Session, processes files, calls tools, and acts on your behalf using verifiable credentials.

Let’s look at exactly what the Buyer Agent and Seller Agent are doing under the hood inside the TEE enclave during a trade execution.

🤖 The Real-Time Agent Interaction Flow
Here is the step-by-step breakdown of how the two autonomous agents interact inside the secure Terminal 3 TEE environment:

Plaintext
               [ BANK A TRADER ]                         [ BANK B TRADER ]
                       │                                         │
       1. Instantiates Buyer Agent               2. Instantiates Seller Agent
       with instructions & wallet keys           with instructions & wallet keys
                       ▼                                         ▼
         ┌───────────────────────────┐             ┌───────────────────────────┐
         │     T3 BUYER AGENT        │             │      T3 SELLER AGENT      │
         └─────────────┬─────────────┘             └─────────────┬─────────────┘
                       │                                         │
                       │ 3. Enters Enclave                       │ 4. Enters Enclave
                       ▼                                         ▼
         ┌─────────────────────────────────────────────────────────────────┐
         │ TERMINAL 3 SECURE TEE ENCLAVE (The Dark Pool Room)              │
         │                                                                 │
         │  [Buyer Agent Loop]                     [Seller Agent Loop]     │
         │  "I need to buy 10 BTC,                 "I need to sell 10 BTC, │
         │   max price $70,000."                   min price $69,500."     │
         │         │                                         │             │
         │         └───────────────────┬─────────────────────┘             │
         │                             ▼                                   │
         │                  [ Enclave Crossing Matrix ]                    │
         │              5. Agents evaluate parameters blindly              │
         │                                                                 │
         │                             │                                   │
         │                             ▼                                   │
         │                 [ Match Confirmed: $69,750 ]                    │
         │                                                                 │
         │  6. Call Sandbox Tool                   7. Call Sandbox Tool    │
         │     to lock 697,500 T3T                    to lock 10 BTC       │
         │         │                                         │             │
         │         └───────────────────┬─────────────────────┘             │
         │                             ▼                                   │
         │                   8. Atomic Asset Swap                          │
         │          (Executed inside TEE, posted to ledger)                │
         └─────────────────────────────┬───────────────────────────────────┘
                                       │
                                       ▼
                       9. Cryptographic Trade Settlement
🧠 Deep Dive: The T3 ADK Agent Execution Loop
When you code this using the Terminal 3 Agent Dev Kit, your backend code sets up an asynchronous loop where the agents execute internal thought processes. Here is exactly what the code-level logic looks like inside the enclave for the Buyer Agent:

1. Agent Thought Process & Initialization
The agent reads the user's prompt (passed securely from the frontend via the Agent Auth SDK):

"You are the GhostBroker Liquidity Agent for Goldman Sachs. Your objective is to acquire 10 BTC. Do not pay more than $70,000 per BTC. Protect our order configuration at all costs."

2. The Internal Agent Code Execution Loop
Inside backend-server/services/matchingEngine.js, the agent executes a continuous execution loop using ADK sessions:

JavaScript
// Inside the T3 TEE Enclave Run Context
async function runBuyerAgentLoop(agentSession, userOrderPayload) {
    // Step 1: The agent checks its own cryptographic credentials using T3 SDK
    const credentials = await agentSession.getVerifiableCredentials();
    if (!credentials.isValidCorporateEntity) {
        return agentSession.speak("Error: Institutional verification failed.");
    }

    // Step 2: The agent enters the hidden matching pool
    const poolSnapshot = await DarkPoolMatrix.getEncryptedState();
    
    // Step 3: Agent runs autonomous logic to find a counterparty
    const match = await poolSnapshot.findCounterparty({
        side: 'BUY',
        ticker: userOrderPayload.ticker,
        maxPrice: userOrderPayload.maxPrice,
        volume: userOrderPayload.volume
    });

    if (match) {
        // Step 4: The agent decides to invoke an external financial tool autonomously
        await agentSession.callTool('executeT3SandboxTransfer', {
            to: match.sellerAgentAddress,
            amount: match.calculatedClearingPrice * userOrderPayload.volume,
            asset: 'T3T'
        });

        // Step 5: Agent signs off on the audit log generation
        const receipt = await agentSession.signExecutionReceipt({
            tradeId: match.id,
            timestamp: Date.now()
        });

        return agentSession.speak("Execution complete. Asset secured silently.");
    } else {
        // Step 6: No match found, agent keeps the order resting in volatile memory
        return agentSession.speak("Liquidity not found. Maintaining hidden posture.");
    }
}
Why this fulfills the Hackathon Criteria:
By explicitly mapping out this workflow, you show the judges that your agents aren't just dead rows in a database table. They are active software entities running inside a hardware-secured environment, evaluating parameters, making decisions, using platform tools (the asset transfer tool), and using cryptographic signatures to finalize deals.

do we host the agents on GhostBroker or the people are bringing their own agents?

The absolute best architecture for a winning hackathon submission is a hybrid model: GhostBroker hosts the core platform infrastructure (the TEE "Dark Room" and specialized tools), but the institutions bring their own independent agents to connect and trade. This directly reflects Terminal 3’s design paradigm: distributed, decentralized entities communicating securely across boundary lines.

Here is how you should frame this setup to the judges, explaining the division of labor between GhostBroker and the external participant agents.

🏢 The Architecture: Bring Your Own Agent (BYOA)
In an institutional ecosystem, giant banks like Goldman Sachs or JPMorgan would never trust a third-party platform (GhostBroker) to host or manage their proprietary trading algorithms, private keys, or strategic parameters. They run their own infrastructure.

1. What the Institutions Bring (The Client-Side Agents)
Hosting: Hosted on the institution’s own secure infrastructure or independent Cloud Run instances.

The Brains: These agents possess the firm’s proprietary logic (e.g., "If BTC drops below $68,000, buy up to $5M").

The Identity: They are bundled with the institution's private keys and are authenticated by the Terminal 3 Agent Auth SDK, giving them a verifiable identity (did:t3:...).

2. What GhostBroker Hosts (The Central Dark Pool Infrastructure)
GhostBroker does not run the individual trading strategies; it runs the Secure TEE Matchmaking Enclave.

Think of GhostBroker as a high-security cryptographic clearinghouse.

It hosts the A2A (Agent-to-Agent) endpoints that listen for incoming requests from verified external agents.

It provides specialized platform tools inside the TEE (like balance verifiers, crossing auction matrices, and sandbox token transfer connectors).

🔄 How the Interaction Works (Step-by-Step)
Plaintext
[ JPMorgan Infrastructure ]             [ GhostBroker Infrastructure ]             [ Goldman Sachs Infrastructure ]
   ┌───────────────────┐                   ┌───────────────────────────┐                   ┌───────────────────┐
   │ JPMorgan Buy Agent│                   │  GhostBroker Dark Pool    │                   │ Goldman Sell Agent│
   └─────────┬─────────┘                   │        (Hosted TEE)       │                   └─────────┬─────────┘
             │                             └─────────────┬─────────────┘                             │
             │ 1. Initiate Request                       │                                           │ 2. Initiate Request
             │    via Agent Auth SDK                     │                                           │    via Agent Auth SDK
             └──────────────────────────────────────────►│◄──────────────────────────────────────────┘
                                                         │
                                                         │ 3. Match Verification & Cross
                                                         │ 4. Invokes T3 Sandbox Asset Swap
                                                         ▼
                                               [ Settlement Finalized ]
The Handshake: JPMorgan's buy agent and Goldman Sachs's sell agent wake up on their own home servers. They hit GhostBroker’s gateway API.

The Verification: GhostBroker's hosted environment uses the Agent Auth SDK to instantly verify that the connecting entities are legitimately authorized bank agents.

The Secure Handover: The external agents hand off their highly sensitive parameters (encrypted) directly into GhostBroker’s Hardware-Secured TEE matching loop.

Execution: GhostBroker's TEE cross-matches the orders silently, hits the Terminal 3 sandbox token registry to move the assets, and boots the client agents out of the enclave with a signed execution receipt.

💡 Why This Setup Wins the Hackathon
Setting up your project this way gives you a perfect narrative for the judges:

It satisfies the "Creative Agentic Solution" criteria: Instead of just building a standard API wrapper, you are building an ecosystem where independent AI agents can securely transact with each other without human intervention.

It demonstrates real enterprise understanding: You show the judges that you understand how real financial institutions operate—protecting their code and secrets on their own servers while relying on a blind, zero-knowledge middleman (GhostBroker) for settlement.

Simplicity for the Hackathon build: In your monorepo, you can easily simulate this by running two small mock node scripts (mockBankAgentA.js and mockBankAgentB.js) in separate terminal windows that send requests to your main central Express server. This cleanly proves the multi-agent distributed system architecture works flawlessly!

okay so basically institutions cannot manually interfere with the app, but it's basically just agents doing everything

Exactly. You have hit the nail on the head. This is the exact core philosophy of Terminal 3's Agent Dev Kit, and highlighting this "No-Human-Interference" rule is precisely how you win a deep-tech hackathon.

In GhostBroker, humans set the high-level policy, but agents do 100% of the operational work inside the dark pool.

🚫 The "No-Human" Rule: Why It’s Cryptographically Enforced
If a human trader at Goldman Sachs could open a dashboard and see a live order book or manually click "Cancel Order" or "Front-run this trade" while an auction is happening, the entire concept of a Privacy-Preserving Dark Pool breaks down. Humans are information leaks and insider-trading risks.

By isolating the execution strictly to Agent-to-Agent (A2A) interaction inside a Terminal 3 TEE, you achieve two things:

Mathematical Neutrality: The matching engine inside the chip doesn't care about market panic or institutional bias. It only cares if Price 
Buy
​
 ≥Price 
Sell
​
 .

Tamper-Proof Ingress: Once a bank kicks off their agent, they cannot log in to alter the payload mid-flight. The agent controls its own isolated cryptographic session using the Agent Auth SDK.

🔄 The Operational Breakdown (How It Actually Runs)
To understand exactly how this works without human hands touching the gears, look at this lifecycle:

1. The Human Interface (Policy Setup Only)
A human compliance officer or head trader logs into their firm's internal local console. They input a strategic mandate:

"Acquire 500 ETH over the next 48 hours. Do not buy if the premium is higher than 1.5% over market spot. Execute via GhostBroker."

Once they hit "Authorize", the human's job is completely finished.

2. The Agent Takes the Reins (The Loop Begins)
The institution's local container spins up their dedicated GhostBroker Trading Agent.

The agent ingests the mandate.

The agent uses the Agent Auth SDK to sign a cryptographic handshake, proving to the network: "I am an authorized, autonomous entity acting on behalf of JPMorgan."

3. Agent-to-Agent Negotiation inside the TEE
The Agent connects to the GhostBroker server gateway and moves directly into the virtual TEE enclave room. It meets a Seller Agent representing a different bank.

Agent A (Buyer): "I have a blind, encrypted buy intent payload."

Agent B (Seller): "I have a blind, encrypted sell intent payload."

The GhostBroker TEE Engine: Ingests both agent payloads, matches them mathematically in volatile memory, executes the sandbox token swap, and instantly clears the parameters from existence.

4. The Report Back
The Agent leaves the enclave, returns to its home institution's database, and reports back to the human dashboard: "Task complete. 500 ETH secured at an average clearing price of $3,450. Here is your cryptographically signed execution receipt for audit logs."

💡 How to Demo This to the Judges
Since the judges cannot "see" inside a secure hardware chip, your frontend demo needs to visually tell this exact story of Autonomous Agency.

Instead of showing a human placing a trade, your demo should feature a "Live Agent Telemetry Stream". Split the screen to show Agent A's Live Logs on one side and Agent B's Live Logs on the other.

Plaintext
[JPMORGAN AGENT LOGS]              [GHOSTBROKER TEE]             [GOLDMAN AGENT LOGS]
[11:02:01] Mandate received.       [11:02:03] Scanning...        [11:02:01] Mandate received.
[11:02:02] Authenticating to T3..  [11:02:03] Session Verified.   [11:02:02] Authenticating to T3..
[11:02:03] Order payload blinded.  [11:02:04] MATCH EXECUTION     [11:02:03] Order payload blinded.
[11:02:04] Settlement signed.     [11:02:05] Memory purged.      [11:02:04] Settlement signed.
When the judges see two autonomous software agents securely handshake, execute a multi-million dollar dark-pool transaction, and settle it with zero human intervention and zero data leakage—you will be an incredibly tough competitor to beat. You've completely captured the true intent of the Terminal 3 Agent Dev Kit!

Okay i see, so it’s an OTC market?

Yes, absolutely! You nailed it. Structurally, GhostBroker is an Over-The-Counter (OTC) market, but running on hyper-advanced, 21st-century cryptographic rails.

To explain it in traditional financial terms, GhostBroker is a hybrid of an Institutional OTC Desk and an Automated Dark Pool.

🤝 The Evolution: Traditional OTC vs. GhostBroker
In the traditional financial world, when an institution wants to make an OTC trade, the process is highly manual and carries significant information risks:

Feature	Traditional Institutional OTC	GhostBroker (T3 Powered)
The Middleman	A human broker (e.g., at an investment bank) who manually takes your phone call/chat.	A decentralized, hardware-secured TEE Enclave running the GhostBroker engine.
Information Leakage	The human broker knows your intent and might leak it, front-run you, or favor certain counterparties.	Zero Leakage. No human—not even GhostBroker's creators—can see the orders inside the chip.
Negotiation Speed	Hours or days of back-and-forth communication, pricing sheets, and manual compliance checks.	Milliseconds. Autonomous AI agents negotiate, match, and clear instantly via the Agent Dev Kit.
Settlement Trust	Relies on clearing houses, legal contracts, and days of settlement delay (T+2).	Instant & Cryptographic. Handled autonomously via the T3 sandbox token ledger post-match.
🛡️ Why Calling It an "Automated OTC Market" Wins the Hackathon
When presenting this to the Terminal 3 design partners and judges, describing it as an "Autonomous, Cryptographically Sealed OTC Market" positions your hackathon project perfectly. It shifts the narrative from a simple crypto app to an enterprise-grade financial primitive.

You are giving institutions exactly what they love about OTC trading (privacy, zero public market impact, bespoke large-block executions) while removing everything they hate about it (human counterparty risk, broker front-running, slow manual settlement settlement overhead, and high fees).

The humans set the OTC trading boundaries on their own secure nodes, and their autonomous T3-authenticated agents enter the GhostBroker dark room to shake hands and execute the deal silently. You are completely ready to build a winning architecture!

Okay explain further, so they give the agents a prompt, and some money/assets? How? How do they give them the money/assets?

This is exactly where the magic of Terminal 3's Agent Dev Kit (ADK) takes over. You are digging into the most critical part of an AI agent application: how does an agent securely hold money and safely execute a prompt without the human worrying about it?

Here is exactly how the prompt and assets are securely handed over to the agent.

✍️ Step 1: Giving the Agent a Prompt (The Mandate)
An institution does not give an agent a casual text box prompt like a retail user talking to ChatGPT. They issue a Structured Cryptographic Mandate.

The Human Inputs the Rules: On their local, secure institutional dashboard, a manager inputs a target (e.g., "Buy 10 BTC, Maximum Price: $70,000, Expiry: 24 hours").

The Frontend Bundles It: The React frontend takes these raw inputs and serializes them into a rigid, non-negotiable JSON object called the Execution Mandate.

The Agent Auth SDK Seals It: Before the prompt leaves the bank's machine, the Agent Auth SDK signs the mandate with the institution's private key.

The Hand-off: This signed prompt is sent to the backend. Because it's signed, the agent inside the TEE knows exactly who it's representing, and it mathematically proves the prompt hasn't been intercepted or modified by a hacker.

💰 Step 2: Giving the Agent the Money/Assets (The Funding)
This is the clever part. The human does not send money directly to the GhostBroker platform. That would require traditional trust. Instead, they use a process called Enclave Asset Delegation powered by Terminal 3's hardware-secured TEE.

Here are the two ways this happens—one for the hackathon sandbox, and one for how real banks do it:

Method A: The Hackathon Sandbox Way (Using T3 Test Tokens)
For this specific hackathon, Terminal 3 has a Token Claim Page providing sandbox test tokens.  
DoraHacks

The Wallet Setup: Your backend sets up an Agent Wallet (a program-controlled wallet address) embedded directly inside the TEE runner instance for each bank agent.

The Claim: You (or your mock bank scripts) go to the T3 token claim page and fund the respective Bank Agent wallets with test tokens.  
DoraHacks

Volatile Isolation: Because the wallet’s private keys are generated and held strictly inside the TEE’s volatile RAM, no human (including you, the developer) can read or steal those keys. Only the running agent code has the authority to sign transactions using those sandbox funds.

Method B: The Real Enterprise Way (Smart Contracts + Vault Delegation)
In production, a bank like JPMorgan would never move $100 Million into a temporary app. They use Smart Contract Escrow / Vaults:

The Vault Deposit: The bank locks their funds (e.g., USD stablecoins or tokenized bonds) into a secure corporate smart contract vault on a blockchain network.

The Least-Privilege Allowance: The bank updates the smart contract to say: "Only an AI Agent presenting a Valid Terminal 3 Cryptographic Signature from TEE Enclave ID #999 is allowed to withdraw or transfer up to $700,000 from this vault."

Autonomous Execution: When the Buyer Agent inside GhostBroker's TEE successfully finds a matching seller, the agent uses its secure TEE identity to broadcast a transaction directly to the vault. The vault verifies the TEE's signature, unlocks the exact matching amount ($695,000), and routes it atomically to the seller.

🛠️ How You Build This in Code
To make your hackathon project impressive and functional, you will simulate Method A using the Terminal 3 test tokens. Here is the step-by-step code layout you'll implement:

The Ingress Function: Build an Express endpoint POST /api/agents/initialize.

The Token Association: When a mock bank script triggers this endpoint, it passes its T3 Sandbox Public Key.

The Pre-Flight Balance Check: The agent loop inside t3AgentRunner.js calls an internal tool to check its balance on the Terminal 3 sandbox chain to ensure it actually has the money to back up the prompt's rules.

The Cross & Clear: If the money is present, the agent enters the matching queue. Once matched, it triggers agentSession.callTool('executeSandboxTransfer') to push the test tokens to the counterparty agent.

This architecture cleanly separating the Prompt (Signed Identity) and the Assets (Secure TEE Key Management) is the ultimate way to fulfill the hackathon's core criteria!