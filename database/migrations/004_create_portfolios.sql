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

-- Seed initial portfolios for existing institutions
-- Each institution gets $50M USD and 500 BTC
INSERT INTO public.portfolios (institution_id, asset_code, balance)
SELECT id, 'USD', 50000000.00
FROM public.institutions
WHERE NOT EXISTS (
  SELECT 1 FROM public.portfolios WHERE institution_id = institutions.id AND asset_code = 'USD'
);

INSERT INTO public.portfolios (institution_id, asset_code, balance)
SELECT id, 'BTC', 500.00000000
FROM public.institutions
WHERE NOT EXISTS (
  SELECT 1 FROM public.portfolios WHERE institution_id = institutions.id AND asset_code = 'BTC'
);

INSERT INTO public.portfolios (institution_id, asset_code, balance)
SELECT id, 'ETH', 10000.00000000
FROM public.institutions
WHERE NOT EXISTS (
  SELECT 1 FROM public.portfolios WHERE institution_id = institutions.id AND asset_code = 'ETH'
);

INSERT INTO public.portfolios (institution_id, asset_code, balance)
SELECT id, 'AAPL', 50000.00000000
FROM public.institutions
WHERE NOT EXISTS (
  SELECT 1 FROM public.portfolios WHERE institution_id = institutions.id AND asset_code = 'AAPL'
);
