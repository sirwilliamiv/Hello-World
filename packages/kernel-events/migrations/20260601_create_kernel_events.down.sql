drop trigger if exists events_no_mutate on events;
drop function if exists events_append_only();
drop table if exists dead_letters;
drop table if exists subscriptions;
drop table if exists events;
