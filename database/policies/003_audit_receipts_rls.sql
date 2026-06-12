alter table audit_receipts enable row level security;

drop policy if exists audit_receipts_service_role_all on audit_receipts;
create policy audit_receipts_service_role_all
  on audit_receipts
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists audit_receipts_institution_read on audit_receipts;
create policy audit_receipts_institution_read
  on audit_receipts
  for select
  using (
    auth.role() = 'authenticated'
    and institution_id::text = auth.jwt() ->> 'institution_id'
  );
