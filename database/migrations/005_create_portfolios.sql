-- Track institution portfolio holdings (cash + assets)
-- Each row represents an institution's balance in one asset
CREATE TABLE IF NOT EXISTS public.portfolios (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  asset_code text NOT NULL,
  balance numeric(40, 8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  locked numeric(40, 8) NOT NULL DEFAULT 0 CHECK (locked >= 0 AND locked <= balance),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT portfolios_pkey PRIMARY KEY (id),
  CONSTRAINT portfolios_institution_asset_unique UNIQUE (institution_id, asset_code)
);
