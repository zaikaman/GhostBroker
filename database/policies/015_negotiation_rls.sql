alter table negotiation_mandates enable row level security;

drop policy if exists negotiation_mandates_service_role_all on negotiation_mandates;
create policy negotiation_mandates_service_role_all
  on negotiation_mandates
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists negotiation_mandates_institution_read on negotiation_mandates;
create policy negotiation_mandates_institution_read
  on negotiation_mandates
  for select
  using (
    auth.role() = 'authenticated'
    and institution_id::text = auth.jwt() ->> 'institution_id'
  );

alter table negotiation_sessions enable row level security;

drop policy if exists negotiation_sessions_service_role_all on negotiation_sessions;
create policy negotiation_sessions_service_role_all
  on negotiation_sessions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists negotiation_sessions_institution_read on negotiation_sessions;
create policy negotiation_sessions_institution_read
  on negotiation_sessions
  for select
  using (
    auth.role() = 'authenticated'
    and (
      buy_institution_id::text = auth.jwt() ->> 'institution_id'
      or sell_institution_id::text = auth.jwt() ->> 'institution_id'
    )
  );

alter table negotiation_rounds enable row level security;

drop policy if exists negotiation_rounds_service_role_all on negotiation_rounds;
create policy negotiation_rounds_service_role_all
  on negotiation_rounds
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists negotiation_rounds_institution_read on negotiation_rounds;
create policy negotiation_rounds_institution_read
  on negotiation_rounds
  for select
  using (
    auth.role() = 'authenticated'
    and exists (
      select 1
      from negotiation_sessions sessions
      where sessions.id = negotiation_rounds.session_id
        and (
          sessions.buy_institution_id::text = auth.jwt() ->> 'institution_id'
          or sessions.sell_institution_id::text = auth.jwt() ->> 'institution_id'
        )
    )
  );

alter table negotiation_disclosures enable row level security;

drop policy if exists negotiation_disclosures_service_role_all on negotiation_disclosures;
create policy negotiation_disclosures_service_role_all
  on negotiation_disclosures
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists negotiation_disclosures_institution_read on negotiation_disclosures;
create policy negotiation_disclosures_institution_read
  on negotiation_disclosures
  for select
  using (
    auth.role() = 'authenticated'
    and exists (
      select 1
      from negotiation_sessions sessions
      where sessions.id = negotiation_disclosures.session_id
        and (
          sessions.buy_institution_id::text = auth.jwt() ->> 'institution_id'
          or sessions.sell_institution_id::text = auth.jwt() ->> 'institution_id'
        )
    )
  );
