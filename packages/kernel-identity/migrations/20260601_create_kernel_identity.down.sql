-- Rollback for 20260601_create_kernel_identity.
-- Dropped in reverse dependency order; a capability major without a working
-- rollback fails publication (ARCHITECTURE.md §9.2).

DROP TABLE IF EXISTS identity_password_resets;
DROP TABLE IF EXISTS identity_email_verifications;
DROP TABLE IF EXISTS identity_credentials;
DROP TABLE IF EXISTS identity_sessions;
DROP TABLE IF EXISTS identity_users;
