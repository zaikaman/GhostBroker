create extension if not exists pgcrypto;

create table if not exists institutions (
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

create index if not exists institutions_status_idx on institutions (status);

create or replace function set_institutions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists institutions_updated_at_trigger on institutions;
create trigger institutions_updated_at_trigger
before update on institutions
for each row
execute function set_institutions_updated_at();
