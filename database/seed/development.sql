insert into institutions (
  legal_name,
  display_name,
  status,
  t3_tenant_did,
  settlement_profile_ref,
  metadata
) values
  (
    'Northstar Capital Markets LLC',
    'Northstar Capital',
    'active',
    'did:t3n:dev:northstar-capital',
    'settlement-profile:northstar:development',
    '{"environment":"development","region":"us"}'::jsonb
  ),
  (
    'Meridian Institutional Trading Ltd',
    'Meridian Trading',
    'active',
    'did:t3n:dev:meridian-trading',
    'settlement-profile:meridian:development',
    '{"environment":"development","region":"eu"}'::jsonb
  )
on conflict (t3_tenant_did) do update set
  legal_name = excluded.legal_name,
  display_name = excluded.display_name,
  status = excluded.status,
  settlement_profile_ref = excluded.settlement_profile_ref,
  metadata = excluded.metadata;
