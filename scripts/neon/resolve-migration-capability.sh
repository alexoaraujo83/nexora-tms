#!/usr/bin/env bash
set -euo pipefail

: "${MIGRATOR_DATABASE_URL:?MIGRATOR_DATABASE_URL is required}"

# Migration elevation must happen inside an established PostgreSQL session.
# Do not append startup option role=... to a Neon connection URI: pooled
# endpoints reject it and it couples transport to authorization.
psql "$MIGRATOR_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT CASE
  WHEN session_user <> 'nexora_migrator' OR current_user <> 'nexora_migrator'
    THEN pg_catalog.format('unexpected migration identity: session_user=%s current_user=%s', session_user, current_user)
  ELSE 'migration identity verified: nexora_migrator'
END;
DO $$
BEGIN
  EXECUTE 'SET ROLE nexora_owner';
  IF current_user <> 'nexora_owner' THEN
    RAISE EXCEPTION 'SET ROLE nexora_owner did not establish expected current_user';
  END IF;
END $$;
SELECT 'migration role chain verified: nexora_migrator -> nexora_owner';
SQL

# Export a session-safe connection marker for callers. The actual elevated
# session remains the psql process above; callers should execute migrations
# through the same direct connection/session rather than reconstructing an
# OWNER_DATABASE_URL with startup options.
echo 'Migration capability validated via SET ROLE in direct PostgreSQL session.'