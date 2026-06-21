import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Manual .env parser to avoid external dependencies in root workspace
function loadDotenv(filePath: string) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const match = trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            let val = match[2].trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            process.env[key] = val;
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to load dotenv file:', err);
  }
}

loadDotenv(path.resolve(__dirname, '../../backend/.env'));

const supabaseUrl = process.env.SUPABASE_URL || 'https://ihfqgsgcmcqasuttwfbi.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.warn('Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from environment. Database seeds might fail.');
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

export const us3BuyerInstitutionId = '00000000-0000-4000-8000-000000000301';
export const us3SellerInstitutionId = '00000000-0000-4000-8000-000000000302';
export const us3UnrelatedInstitutionId = '00000000-0000-4000-8000-000000000303';

export const us3ReceiptId = '00000000-0000-4000-8000-000000000331';
export const us3CompletedTradeId = '00000000-0000-4000-8000-000000000341';

export async function clearDatabase() {
  // Delete in order of dependency constraints
  await supabase.from('audit_receipts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase.from('completed_trades').delete().neq('id', '00000000-0000-0000-0000-000000000000');
}

export async function seedInstitutions() {
  const institutions = [
    {
      id: us3BuyerInstitutionId,
      legal_name: 'Northstar Capital Markets LLC',
      display_name: 'Northstar Capital',
      status: 'active',
      t3_tenant_did: 'did:t3n:e2e:buyer',
      settlement_profile_ref: 'settlement-profile:northstar:development',
      metadata: { environment: 'development', region: 'us' },
    },
    {
      id: us3SellerInstitutionId,
      legal_name: 'Meridian Institutional Trading Ltd',
      display_name: 'Meridian Trading',
      status: 'active',
      t3_tenant_did: 'did:t3n:e2e:seller',
      settlement_profile_ref: 'settlement-profile:meridian:development',
      metadata: { environment: 'development', region: 'eu' },
    },
    {
      id: us3UnrelatedInstitutionId,
      legal_name: 'Mercurial Global Markets LLC',
      display_name: 'Mercurial Global',
      status: 'active',
      t3_tenant_did: 'did:t3n:e2e:unrelated',
      settlement_profile_ref: 'settlement-profile:mercurial:development',
      metadata: { environment: 'development', region: 'eu' },
    },
  ];

  for (const inst of institutions) {
    const { error } = await supabase.from('institutions').upsert(inst, { onConflict: 'id' });
    if (error) {
      console.error(`Failed to seed institution ${inst.display_name}:`, error);
      throw error;
    }
  }
}

export async function seedCompletedTradeAndReceipt() {
  // 1. Seed completed trade
  const trade = {
    id: us3CompletedTradeId,
    trade_ref: 'match_outcome_us3',
    buy_institution_id: us3BuyerInstitutionId,
    sell_institution_id: us3SellerInstitutionId,
    asset_code_ciphertext: 'aead.v1:test:asset_us3',
    quantity_ciphertext: 'aead.v1:test:qty_us3',
    execution_price_ciphertext: 'aead.v1:test:price_us3',
    settlement_status: 'settled',
    settled_at: new Date().toISOString(),
    t3_execution_ref: 't3exec_us3',
  };

  const { error: tradeError } = await supabase.from('completed_trades').upsert(trade, { onConflict: 'id' });
  if (tradeError) {
    console.error('Failed to seed completed trade:', tradeError);
    throw tradeError;
  }

  // 2. Seed audit receipt (for buyer)
  const receipt = {
    id: us3ReceiptId,
    completed_trade_id: us3CompletedTradeId,
    institution_id: us3BuyerInstitutionId,
    receipt_ciphertext: 't3receipt.buyer.ciphertext_payload_envelope_contents_sealed_in_tee_enclave',
    receipt_hash: 'sha256:buyer-receipt-audit-hash-code-verification-reference',
    key_version: 'key-v3',
    t3_attestation_ref: 't3attest_buyer_verification_attestation_proof',
    access_scope: 'buyer',
  };

  const { error: receiptError } = await supabase.from('audit_receipts').upsert(receipt, { onConflict: 'id' });
  if (receiptError) {
    console.error('Failed to seed audit receipt:', receiptError);
    throw receiptError;
  }
}
