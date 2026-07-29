drop trigger if exists audit_entry_no_mutate on audit_entry;
drop function if exists audit_entry_append_only();
drop table if exists audit_entry;
