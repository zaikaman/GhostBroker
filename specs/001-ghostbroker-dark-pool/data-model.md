# Data Model: GhostBroker Institutional Dark Pool

## Overview

Supabase PostgreSQL is the durable system of record for institution metadata, completed trade history, and encrypted receipts. Active hidden order parameters are not stored in Supabase. Active intent state is represented outside the database by opaque T3 handles and sanitized telemetry.

## Entities

### Institution

Represents a financial institution participating in GhostBroker.

**Fields**:

- `id`: UUID primary key.
- `legal_name`: legal registered name.
- `display_name`: dashboard display label.
- `status`: `pending`, `active`, `suspended`, or `closed`.
- `t3_tenant_did`: Terminal 3 tenant DID.
- `settlement_profile_ref`: reference to settlement configuration, not raw credentials.
- `metadata`: non-sensitive JSON metadata.
- `created_at`, `updated_at`: timestamps.

**Validation**:

- `t3_tenant_did` must be unique.
- Suspended or closed institutions cannot onboard new agents or submit intent.

**Relationships**:

- Has many completed trades as buyer or seller.
- Has many audit receipts.

### CompletedTrade

Represents a settled trade visible only to participating institutions.

**Fields**:

- `id`: UUID primary key.
- `trade_ref`: unique external reference.
- `buy_institution_id`: buyer institution.
- `sell_institution_id`: seller institution.
- `asset_code_ciphertext`: encrypted asset code.
- `quantity_ciphertext`: encrypted settled quantity.
- `execution_price_ciphertext`: encrypted settlement price.
- `settlement_status`: `settled`, `failed`, or `reversed`.
- `settled_at`: settlement completion time.
- `t3_execution_ref`: opaque Terminal 3 execution reference.
- `created_at`: record creation time.

**Validation**:

- Buyer and seller must be different active institutions.
- A trade is visible only to the buyer, seller, or privileged service role.
- Records are written only after settlement completes or fails atomically.

**Relationships**:

- Belongs to buyer institution.
- Belongs to seller institution.
- Has many audit receipts.

### AuditReceipt

Represents an encrypted receipt for a completed trade.

**Fields**:

- `id`: UUID primary key.
- `completed_trade_id`: completed trade reference.
- `institution_id`: receipt owner.
- `receipt_ciphertext`: encrypted receipt payload.
- `receipt_hash`: integrity hash for receipt verification.
- `key_version`: receipt encryption key version.
- `t3_attestation_ref`: opaque reference to T3 attestation or execution evidence.
- `access_scope`: `buyer`, `seller`, or `regulatory_export`.
- `created_at`: receipt creation time.
- `opened_at`: first authorized opening time.

**Validation**:

- Receipt owner must be a participant in the completed trade unless `access_scope` is `regulatory_export`.
- Receipt plaintext must never be stored in PostgreSQL.
- Receipt reads create audit events.

**Relationships**:

- Belongs to completed trade.
- Belongs to institution.

## Non-Persistent Runtime Concepts

### HiddenTradingIntent

Opaque runtime concept managed by `t3-enclave/`.

**Visible outside T3**:

- `intent_handle`
- `owning_institution_id`
- `agent_id`
- redacted lifecycle state
- timestamps

**Never visible outside T3**:

- asset
- side
- quantity
- bid or ask price
- queue position
- compatible counterparties
- match score

### AgentAuthority

Authority claims are managed through Terminal 3 identity and delegated agent grants. Current docs show dashboard-provisioned AI agent delegation; programmatic grant management must be used only if Terminal 3 exposes a real SDK/API. Supabase may store non-sensitive references such as DID, status, grant reference, and policy hash, but detailed authority verification is performed through `t3-enclave/` and must fail closed when grant verification is unavailable.

## State Transitions

### Institution

```text
pending -> active -> suspended -> active
active -> closed
suspended -> closed
```

### HiddenTradingIntent

```text
submitted -> agent_verified -> intent_sealed -> evaluating -> matched -> settlement_pending -> completed
submitted -> rejected
intent_sealed -> expired
intent_sealed -> canceled
settlement_pending -> failed
```

Only redacted state names may be emitted outside `t3-enclave/`.

### CompletedTrade

```text
settled -> reversed
failed
```

## PostgreSQL Layout

```sql
create table institutions (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  display_name text not null,
  status text not null check (status in ('pending', 'active', 'suspended', 'closed')),
  t3_tenant_did text not null unique,
  settlement_profile_ref text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table completed_trades (
  id uuid primary key default gen_random_uuid(),
  trade_ref text not null unique,
  buy_institution_id uuid not null references institutions(id),
  sell_institution_id uuid not null references institutions(id),
  asset_code_ciphertext text not null,
  quantity_ciphertext text not null,
  execution_price_ciphertext text not null,
  settlement_status text not null check (settlement_status in ('settled', 'failed', 'reversed')),
  settled_at timestamptz not null,
  t3_execution_ref text not null,
  created_at timestamptz not null default now(),
  check (buy_institution_id <> sell_institution_id)
);

create table audit_receipts (
  id uuid primary key default gen_random_uuid(),
  completed_trade_id uuid not null references completed_trades(id) on delete cascade,
  institution_id uuid not null references institutions(id),
  receipt_ciphertext text not null,
  receipt_hash text not null,
  key_version text not null,
  t3_attestation_ref text not null,
  access_scope text not null check (access_scope in ('buyer', 'seller', 'regulatory_export')),
  created_at timestamptz not null default now(),
  opened_at timestamptz
);
```
