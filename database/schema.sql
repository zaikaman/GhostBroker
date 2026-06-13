-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.institutions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text, 'closed'::text])),
  t3_tenant_did text NOT NULL UNIQUE,
  settlement_profile_ref text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT institutions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.agent_authority_revocations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  agent_did text NOT NULL,
  authority_ref text NOT NULL,
  reason text NOT NULL CHECK (reason = ANY (ARRAY['operator_revoked'::text, 'policy_replaced'::text, 'credential_compromised'::text, 'terminal3_revoked'::text])),
  revoked_by text NOT NULL,
  revoked_at timestamp with time zone NOT NULL DEFAULT now(),
  unrevoked_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agent_authority_revocations_pkey PRIMARY KEY (id),
  CONSTRAINT agent_authority_revocations_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.completed_trades (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  trade_ref text NOT NULL UNIQUE,
  buy_institution_id uuid NOT NULL,
  sell_institution_id uuid NOT NULL,
  asset_code_ciphertext text NOT NULL CHECK (asset_code_ciphertext <> ''::text),
  quantity_ciphertext text NOT NULL CHECK (quantity_ciphertext <> ''::text),
  execution_price_ciphertext text NOT NULL CHECK (execution_price_ciphertext <> ''::text),
  settlement_status text NOT NULL CHECK (settlement_status = ANY (ARRAY['settled'::text, 'failed'::text, 'reversed'::text])),
  settled_at timestamp with time zone NOT NULL,
  t3_execution_ref text NOT NULL CHECK (t3_execution_ref <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT completed_trades_pkey PRIMARY KEY (id),
  CONSTRAINT completed_trades_buy_institution_id_fkey FOREIGN KEY (buy_institution_id) REFERENCES public.institutions(id),
  CONSTRAINT completed_trades_sell_institution_id_fkey FOREIGN KEY (sell_institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.audit_receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  completed_trade_id uuid NOT NULL,
  institution_id uuid NOT NULL,
  receipt_ciphertext text NOT NULL CHECK (receipt_ciphertext <> ''::text),
  receipt_hash text NOT NULL CHECK (receipt_hash <> ''::text),
  key_version text NOT NULL CHECK (key_version <> ''::text),
  t3_attestation_ref text NOT NULL CHECK (t3_attestation_ref <> ''::text),
  access_scope text NOT NULL CHECK (access_scope = ANY (ARRAY['buyer'::text, 'seller'::text, 'regulatory_export'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  opened_at timestamp with time zone,
  CONSTRAINT audit_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT audit_receipts_completed_trade_id_fkey FOREIGN KEY (completed_trade_id) REFERENCES public.completed_trades(id),
  CONSTRAINT audit_receipts_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.portfolios (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  asset_code text NOT NULL,
  balance numeric NOT NULL DEFAULT 0 CHECK (balance >= 0::numeric),
  locked numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT portfolios_pkey PRIMARY KEY (id),
  CONSTRAINT portfolios_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.portfolio_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  asset_code text NOT NULL,
  delta numeric NOT NULL,
  balance_after numeric NOT NULL,
  change_type text NOT NULL CHECK (change_type = ANY (ARRAY['settlement_buy'::text, 'settlement_sell'::text, 'adjustment'::text, 'import'::text])),
  reference_type text,
  reference_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT portfolio_history_pkey PRIMARY KEY (id),
  CONSTRAINT portfolio_history_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  label text NOT NULL CHECK (label <> ''::text AND char_length(label) <= 100),
  prefix text NOT NULL CHECK (prefix <> ''::text AND char_length(prefix) <= 16),
  key_hash text NOT NULL UNIQUE CHECK (key_hash <> ''::text),
  scopes text NOT NULL DEFAULT 'agent:operate'::text CHECK (scopes <> ''::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone,
  CONSTRAINT api_keys_pkey PRIMARY KEY (id),
  CONSTRAINT api_keys_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL,
  agent_did text NOT NULL CHECK (agent_did <> ''::text),
  status text NOT NULL DEFAULT 'admitted'::text CHECK (status = ANY (ARRAY['admitted'::text, 'revoked'::text])),
  authority_ref text NOT NULL CHECK (authority_ref <> ''::text),
  label text CHECK (label IS NULL OR label <> ''::text AND char_length(label) <= 100),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT agents_pkey PRIMARY KEY (id),
  CONSTRAINT agents_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);