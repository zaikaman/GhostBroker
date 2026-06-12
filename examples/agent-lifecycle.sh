#!/usr/bin/env bash
# GhostBroker Agent Lifecycle Demo
# Demonstrates the complete agent lifecycle: auth → admission → intent → settlement → receipt
#
# Prerequisites:
#   - jq installed (https://stedolan.github.io/jq/)
#   - node with ethers.js installed (npm install -g ethers)
#   - A running GhostBroker backend (default: http://localhost:3001)

set -euo pipefail

GHOSTBROKER_URL="${GHOSTBROKER_URL:-http://localhost:3001}"
INSTITUTION_DID="${INSTITUTION_DID:-did:t3n:0x1234567890abcdef1234567890abcdef12345678}"
AGENT_DID="${AGENT_DID:-did:t3n:0xAgentAddress1234567890abcdef12345678}"
ADMIN_PRIVATE_KEY="${ADMIN_PRIVATE_KEY:-0x...}"  # Your admin wallet private key
AGENT_PRIVATE_KEY="${AGENT_PRIVATE_KEY:-0x...}"   # Your agent wallet private key

echo "═══════════════════════════════════════════"
echo "  GhostBroker Agent Lifecycle Demo"
echo "═══════════════════════════════════════════"
echo ""
echo "Server: $GHOSTBROKER_URL"
echo "Institution DID: $INSTITUTION_DID"
echo "Agent DID: $AGENT_DID"
echo ""

# Step 1: Health Check
echo "▸ Step 1: Health Check"
HEALTH=$(curl -s "$GHOSTBROKER_URL/api/health")
echo "  Status: $(echo "$HEALTH" | jq -r '.status')"
echo "  Services: $(echo "$HEALTH" | jq -r '.services | to_entries | map("\(.key)=\(.value)") | join(", ")')"
echo ""

# Step 2: Authentication Challenge
echo "▸ Step 2: Request Authentication Challenge"
CHALLENGE_RESP=$(curl -s -X POST "$GHOSTBROKER_URL/api/auth/challenge" \
  -H 'Content-Type: application/json' \
  -d "{\"did\": \"$INSTITUTION_DID\"}")
CHALLENGE_ID=$(echo "$CHALLENGE_RESP" | jq -r '.challengeId')
CHALLENGE=$(echo "$CHALLENGE_RESP" | jq -r '.challenge')
echo "  Challenge ID: $CHALLENGE_ID"
echo ""

# Step 3: Sign Challenge (requires ethers.js)
echo "▸ Step 3: Sign Challenge with Wallet"
SIGNATURE=$(node -e "
  const { Wallet } = require('ethers');
  const wallet = new Wallet('$ADMIN_PRIVATE_KEY');
  wallet.signMessage(process.argv[1]).then(s => {
    console.log(JSON.stringify({ signature: s, address: wallet.address }));
  });
" "$CHALLENGE")
SIG_VALUE=$(echo "$SIGNATURE" | jq -r '.signature')
WALLET_ADDR=$(echo "$SIGNATURE" | jq -r '.address')
echo "  Signer: $WALLET_ADDR"
echo "  Signature: ${SIG_VALUE:0:20}..."
echo ""

# Step 4: Verify Challenge → Get Token
echo "▸ Step 4: Verify Challenge & Get Session Token"
TOKEN_RESP=$(curl -s -X POST "$GHOSTBROKER_URL/api/auth/verify" \
  -H 'Content-Type: application/json' \
  -d "{
    \"challengeId\": \"$CHALLENGE_ID\",
    \"did\": \"$INSTITUTION_DID\",
    \"signature\": \"$SIG_VALUE\",
    \"walletAddress\": \"$WALLET_ADDR\"
  }")
TOKEN=$(echo "$TOKEN_RESP" | jq -r '.token')
INSTITUTION_ID=$(echo "$TOKEN_RESP" | jq -r '.institution.id')
echo "  Token: ${TOKEN:0:30}..."
echo "  Institution ID: $INSTITUTION_ID"
echo ""

# Step 5: Admit Agent
echo "▸ Step 5: Admit Agent with Delegation Proof"
echo "  (Requires a valid delegation credential from T3N Dashboard)"
echo "  Skipping — use the @ghostbroker/agent-client SDK to build the proof."
echo ""

read -p "  Enter authorityProof JSON string (or press Enter to skip): " AUTHORITY_PROOF
if [ -n "$AUTHORITY_PROOF" ]; then
  ADMIT_RESP=$(curl -s -X POST "$GHOSTBROKER_URL/api/agents/admit" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{
      \"institutionId\": \"$INSTITUTION_ID\",
      \"agentDid\": \"$AGENT_DID\",
      \"authorityProof\": $(echo "$AUTHORITY_PROOF" | jq -Rs '.')
    }")
  echo "  Admission: $(echo "$ADMIT_RESP" | jq -r '.status')"
  echo "  Authority Ref: $(echo "$ADMIT_RESP" | jq -r '.authorityRef')"
fi
echo ""

# Step 6: Submit Encrypted Intent
echo "▸ Step 6: Submit Encrypted Trading Intent"
echo "  (Requires an encrypted intent envelope)"
echo ""
read -p "  Enter encrypted intent envelope (or press Enter to skip): " ENVELOPE
if [ -n "$ENVELOPE" ]; then
  INTENT_RESP=$(curl -s -X POST "$GHOSTBROKER_URL/api/agents/intents" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{
      \"institutionId\": \"$INSTITUTION_ID\",
      \"agentDid\": \"$AGENT_DID\",
      \"encryptedIntentEnvelope\": \"$ENVELOPE\",
      \"authorityRef\": \"$AUTHORITY_PROOF\"
    }")
  echo "  Intent Handle: $(echo "$INTENT_RESP" | jq -r '.intentHandle')"
  echo "  State: $(echo "$INTENT_RESP" | jq -r '.state')"
fi
echo ""

# Step 7: Check Completed Trades
echo "▸ Step 7: Check Completed Trades"
TRADES=$(curl -s "$GHOSTBROKER_URL/api/trades/completed" \
  -H "Authorization: Bearer $TOKEN")
TRADE_COUNT=$(echo "$TRADES" | jq '.items | length')
echo "  Completed trades: $TRADE_COUNT"
echo ""

echo "═══════════════════════════════════════════"
echo "  Lifecycle demo complete."
echo "  See docs/agent-integration/ for full documentation."
echo "═══════════════════════════════════════════"
