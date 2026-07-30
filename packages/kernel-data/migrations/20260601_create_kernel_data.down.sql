-- Deliberately does NOT drop forge_migrations: that is the record of what has
-- been applied, and removing it while rolling back would lose the ability to
-- tell what still needs rolling back.
drop index if exists forge_migrations_capability_idx;
