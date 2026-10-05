-- SigmaDesk production read access: provision the read-only role the DESK (never a seat) uses for `desk ops` probes.
--
-- The OWNER runs this by hand, as a superuser, once per database server (roles are per cluster), per database:
--   psql -h 127.0.0.1 -p 5433 -U postgres -d trading_ts  -v ON_ERROR_STOP=1 -f scripts/provision-role.sql
--   psql -h 127.0.0.1 -p 5434 -U postgres -d trading_app -v ON_ERROR_STOP=1 -f scripts/provision-role.sql
-- then sets the password interactively (never in a file the desk config or a seat can read):  \password sigmadesk_ro
-- and stores it in the desk's pgpass file (chmod 600), e.g. ~/.pgpass-sigmadesk:
--   127.0.0.1:5433:trading_ts:sigmadesk_ro:<password>
--
-- What it does, and only this:
--   * creates (or re-asserts the attributes of) a NON-owner login role, read-only by default, with tight defaults;
--   * grants pg_read_all_stats (session statistics), CONNECT, USAGE on public, SELECT on four Timescale information
--     views, and SELECT on reviewed time columns only;
--   * NEVER changes PUBLIC privileges or any other role (see scripts/audit-public-functions.sql: read-only report).
-- It ABORTS, changing nothing, if an existing sigmadesk_ro holds anything beyond that reviewed set: other memberships,
-- object ownership, table-level privileges, unreviewed column privileges, function/schema/database privileges beyond
-- the list, or dangerous attributes. Clean such a role up by hand (or drop it) and re-run.
\set ON_ERROR_STOP 1
BEGIN;

-- 0. Preflight on an existing role: anything outside the reviewed set stops provisioning.
DO $$
DECLARE r oid; bad text := '';
BEGIN
  SELECT oid INTO r FROM pg_roles WHERE rolname = 'sigmadesk_ro';
  IF r IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = r AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
    bad := bad || E'\n  - dangerous role attributes (superuser/createrole/createdb/replication/bypassrls)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r AND g.rolname <> 'pg_read_all_stats') THEN
    bad := bad || E'\n  - member of: ' || (SELECT string_agg(g.rolname, ', ') FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r AND g.rolname <> 'pg_read_all_stats');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r) THEN bad := bad || E'\n  - other roles are members of sigmadesk_ro'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = r) OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r) OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = r)
     OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = r AND typrelid = 0) THEN
    bad := bad || E'\n  - owns objects in this database';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'sigmadesk_ro'
             AND NOT (table_schema = 'timescaledb_information' AND table_name IN ('jobs', 'job_stats', 'job_errors', 'continuous_aggregates') AND privilege_type = 'SELECT')) THEN
    bad := bad || E'\n  - table privileges beyond the reviewed views: ' || (SELECT string_agg(DISTINCT table_schema || '.' || table_name || ' ' || privilege_type, ', ') FROM information_schema.role_table_grants WHERE grantee = 'sigmadesk_ro'
             AND NOT (table_schema = 'timescaledb_information' AND table_name IN ('jobs', 'job_stats', 'job_errors', 'continuous_aggregates') AND privilege_type = 'SELECT'));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE grantee = 'sigmadesk_ro'
             AND NOT (privilege_type = 'SELECT' AND table_schema = 'public' AND (table_name, column_name) IN
               (('bar_ticks', 'timestamp'), ('bar_ticks', 'timeframe'), ('bar_ticks_1s', 'timestamp'), ('whale_trades', 'timestamp'), ('bars_1m', 'bucket')))) THEN
    bad := bad || E'\n  - column privileges beyond the reviewed time columns';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE a.grantee = r) THEN bad := bad || E'\n  - explicit function privileges'; END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE a.grantee = r AND NOT (a.privilege_type = 'USAGE' AND n.nspname IN ('public', 'timescaledb_information'))) THEN
    bad := bad || E'\n  - schema privileges beyond USAGE on public/timescaledb_information';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_database d, LATERAL aclexplode(d.datacl) a WHERE a.grantee = r AND a.privilege_type <> 'CONNECT') THEN bad := bad || E'\n  - database privileges beyond CONNECT'; END IF;
  IF EXISTS (SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a WHERE a.grantee = r OR d.defaclrole = r) THEN bad := bad || E'\n  - default privileges involving the role'; END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'sigmadesk_ro already exists with privileges outside the reviewed set; nothing was changed:%', bad;
  END IF;
END $$;

-- 1. The role: login, nothing powerful, read-only by default, few connections, tight defaults.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sigmadesk_ro') THEN
    CREATE ROLE sigmadesk_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
  ELSE
    ALTER ROLE sigmadesk_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
  END IF;
END $$;
ALTER ROLE sigmadesk_ro SET default_transaction_read_only = on;
ALTER ROLE sigmadesk_ro SET statement_timeout = '15s';
ALTER ROLE sigmadesk_ro SET lock_timeout = '1s';
ALTER ROLE sigmadesk_ro SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE sigmadesk_ro SET work_mem = '4MB';
ALTER ROLE sigmadesk_ro SET max_parallel_workers_per_gather = 0;
ALTER ROLE sigmadesk_ro SET temp_file_limit = '64MB';
-- Probes run `SET LOCAL temp_file_limit`, which needs an explicit SET privilege (PostgreSQL 15+).
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'GRANT SET ON PARAMETER temp_file_limit TO sigmadesk_ro';
  ELSE
    RAISE WARNING 'PostgreSQL < 15: cannot GRANT SET ON PARAMETER temp_file_limit; desk ops DB probes will fail here';
  END IF;
END $$;

-- 2. Session statistics (pg_stat_activity/replication for other sessions). NOINHERIT above means the membership is
-- only usable through SET ROLE, so grant it WITH INHERIT where supported (PostgreSQL 16+), else rely on INHERIT.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE 'GRANT pg_read_all_stats TO sigmadesk_ro WITH INHERIT TRUE';
  ELSE
    EXECUTE 'ALTER ROLE sigmadesk_ro INHERIT';
    EXECUTE 'GRANT pg_read_all_stats TO sigmadesk_ro';
  END IF;
END $$;

-- 3. Connect, and read exactly what the probes read.
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO sigmadesk_ro', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO sigmadesk_ro;
DO $$
DECLARE v text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA timescaledb_information TO sigmadesk_ro';
    FOREACH v IN ARRAY ARRAY['jobs', 'job_stats', 'job_errors', 'continuous_aggregates'] LOOP
      IF to_regclass('timescaledb_information.' || v) IS NOT NULL THEN
        EXECUTE format('GRANT SELECT ON timescaledb_information.%I TO sigmadesk_ro', v);
      END IF;
    END LOOP;
  END IF;
END $$;
-- Reviewed columns for ingest_freshness: the time/partition column (and the timeframe filter) only. Keep this list in
-- step with ops.freshness in the desk config AND with the preflight above; missing tables are skipped.
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT * FROM (VALUES ('bar_ticks', 'timestamp'), ('bar_ticks', 'timeframe'), ('bar_ticks_1s', 'timestamp'), ('whale_trades', 'timestamp'), ('bars_1m', 'bucket')) AS t(rel, col) LOOP
    IF to_regclass('public.' || g.rel) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%I) ON public.%I TO sigmadesk_ro', g.col, g.rel);
    END IF;
  END LOOP;
END $$;

COMMIT;

\echo '== sigmadesk_ro now holds:'
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'sigmadesk_ro';
SELECT g.rolname AS member_of FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'sigmadesk_ro';
SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'sigmadesk_ro' ORDER BY 1, 2;
SELECT table_schema, table_name, string_agg(column_name, ', ') AS columns FROM information_schema.column_privileges WHERE grantee = 'sigmadesk_ro' GROUP BY 1, 2 ORDER BY 1, 2;
