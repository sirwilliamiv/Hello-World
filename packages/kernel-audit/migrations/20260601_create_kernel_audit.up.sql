create table if not exists audit_entry (
  id                 text primary key,
  occurred_at_serial bigint not null,
  actor              text,
  action             text not null,
  entity             text,
  entity_id          text,
  summary            text not null
);
create index if not exists audit_entry_entity_idx on audit_entry (entity, entity_id);
create index if not exists audit_entry_serial_idx on audit_entry (occurred_at_serial desc);

-- Append-only enforced by the database, not by convention. An audit trail that
-- can be edited is not evidence of anything.
create or replace function audit_entry_append_only() returns trigger as $$
begin
  raise exception 'audit_entry is append-only; corrections are new entries';
end;
$$ language plpgsql;

drop trigger if exists audit_entry_no_mutate on audit_entry;
create trigger audit_entry_no_mutate before update or delete on audit_entry
  for each row execute function audit_entry_append_only();
