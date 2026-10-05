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
-- the list, a membership WITH ADMIN OPTION, or dangerous attributes. Clean such a role up by hand (or drop it) and re-run.
--
-- Runtime: GRANT on a Timescale hypertable column is propagated by Timescale to every chunk (one ACL catalog update per
-- chunk, catalog row locks only — no AccessExclusiveLock on chunks, no table rewrite). With ~2,400 chunks across the
-- approved tables expect a few seconds to a few tens of seconds. The whole script is ONE transaction with
-- lock_timeout 2s and statement_timeout 120s: if a lock cannot be had quickly or a statement runs long, everything rolls
-- back and nothing changes — re-run later (outside market hours is kindest). Re-running a completed provisioning is safe:
-- the preflight accepts exactly what this script grants (including the chunk grants Timescale propagated) and every
-- GRANT is idempotent.
\set ON_ERROR_STOP 1
\echo '== server and TimescaleDB versions'
SELECT current_setting('server_version') AS postgres, (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS timescaledb;
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

-- The reviewed set, in one place: (relation in public, column). Keep in step with ops.freshness in the desk config.
CREATE TEMP TABLE sigmadesk_approved_cols (rel text, col text) ON COMMIT DROP;
INSERT INTO sigmadesk_approved_cols VALUES ('bar_ticks', 'timestamp'), ('bar_ticks', 'timeframe'), ('bar_ticks_1s', 'timestamp'), ('whale_trades', 'timestamp'), ('bars_1m', 'bucket');
-- Every relation those grants may legitimately land on: the public relation itself, the chunks Timescale propagates a
-- hypertable grant to, and a continuous aggregate's materialization hypertable and ITS chunks.
CREATE TEMP TABLE sigmadesk_family (relid oid, parent text) ON COMMIT DROP;
INSERT INTO sigmadesk_family SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN (SELECT rel FROM sigmadesk_approved_cols);
DO $$
BEGIN
  IF to_regclass('_timescaledb_catalog.chunk') IS NOT NULL THEN
    -- chunks of approved hypertables
    INSERT INTO sigmadesk_family
      SELECT format('%I.%I', ch.schema_name, ch.table_name)::regclass, h.table_name
        FROM _timescaledb_catalog.chunk ch JOIN _timescaledb_catalog.hypertable h ON h.id = ch.hypertable_id
       WHERE h.schema_name = 'public' AND h.table_name IN (SELECT rel FROM sigmadesk_approved_cols) AND to_regclass(format('%I.%I', ch.schema_name, ch.table_name)) IS NOT NULL;
    -- materialization hypertables of approved continuous aggregates, and their chunks
    IF to_regclass('_timescaledb_catalog.continuous_agg') IS NOT NULL THEN
      INSERT INTO sigmadesk_family
        SELECT format('%I.%I', mh.schema_name, mh.table_name)::regclass, ca.user_view_name
          FROM _timescaledb_catalog.continuous_agg ca JOIN _timescaledb_catalog.hypertable mh ON mh.id = ca.mat_hypertable_id
         WHERE ca.user_view_schema = 'public' AND ca.user_view_name IN (SELECT rel FROM sigmadesk_approved_cols)
        UNION ALL
        SELECT format('%I.%I', ch.schema_name, ch.table_name)::regclass, ca.user_view_name
          FROM _timescaledb_catalog.continuous_agg ca JOIN _timescaledb_catalog.chunk ch ON ch.hypertable_id = ca.mat_hypertable_id
         WHERE ca.user_view_schema = 'public' AND ca.user_view_name IN (SELECT rel FROM sigmadesk_approved_cols) AND to_regclass(format('%I.%I', ch.schema_name, ch.table_name)) IS NOT NULL;
    END IF;
  END IF;
END $$;

-- 0. Preflight on an existing role, read from the catalogs' own ACLs: anything outside the reviewed set stops
-- provisioning before any change.
DO $$
DECLARE r oid; bad text := ''; x text;
BEGIN
  SELECT oid INTO r FROM pg_roles WHERE rolname = 'sigmadesk_ro';
  IF r IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = r AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
    bad := bad || E'\n  - dangerous role attributes (superuser/createrole/createdb/replication/bypassrls)';
  END IF;
  SELECT string_agg(g.rolname || CASE WHEN m.admin_option THEN ' (WITH ADMIN OPTION)' ELSE '' END, ', ') INTO x
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r AND (g.rolname <> 'pg_read_all_stats' OR m.admin_option);
  IF x IS NOT NULL THEN bad := bad || E'\n  - unexpected memberships: ' || x; END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r) THEN bad := bad || E'\n  - other roles are members of sigmadesk_ro'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = r) OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r)
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r) OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = r)
     OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = r AND typrelid = 0) THEN
    bad := bad || E'\n  - owns objects in this database';
  END IF;
  -- table-level privileges: only SELECT on the four Timescale information views
  SELECT string_agg(DISTINCT n.nspname || '.' || c.relname || ' ' || a.privilege_type, ', ') INTO x
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
   WHERE a.grantee = r AND NOT (n.nspname = 'timescaledb_information' AND c.relname IN ('jobs', 'job_stats', 'job_errors', 'continuous_aggregates') AND a.privilege_type = 'SELECT');
  IF x IS NOT NULL THEN bad := bad || E'\n  - table privileges beyond the reviewed views: ' || left(x, 400); END IF;
  -- column privileges: only SELECT on approved columns of approved relations or their propagated chunks
  SELECT string_agg(DISTINCT c.oid::regclass::text || '.' || at.attname || ' ' || a.privilege_type, ', ') INTO x
    FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid, LATERAL aclexplode(at.attacl) a
   WHERE a.grantee = r AND NOT (a.privilege_type = 'SELECT' AND EXISTS (
     SELECT 1 FROM sigmadesk_family f JOIN sigmadesk_approved_cols ac ON ac.rel = f.parent WHERE f.relid = c.oid AND ac.col = at.attname));
  IF x IS NOT NULL THEN bad := bad || E'\n  - column privileges beyond the reviewed time columns: ' || left(x, 400); END IF;
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
-- Reviewed columns for ingest_freshness: the time/partition column (and the timeframe filter) only. Timescale propagates
-- each grant to the hypertable's chunks (see Runtime above). Missing tables are skipped.
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT rel, col FROM sigmadesk_approved_cols LOOP
    IF to_regclass('public.' || quote_ident(g.rel)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%I) ON public.%I TO sigmadesk_ro', g.col, g.rel);
    END IF;
  END LOOP;
END $$;

COMMIT;

\echo '== sigmadesk_ro now holds:'
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'sigmadesk_ro';
SELECT g.rolname AS member_of FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'sigmadesk_ro';
SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'sigmadesk_ro' ORDER BY 1, 2;
SELECT table_schema, table_name, string_agg(column_name, ', ') AS columns FROM information_schema.column_privileges
 WHERE grantee = 'sigmadesk_ro' AND table_schema NOT LIKE '\_timescaledb%' GROUP BY 1, 2 ORDER BY 1, 2;
\echo '== chunks carrying the propagated column grants'
SELECT table_schema, count(DISTINCT table_name) AS chunks FROM information_schema.column_privileges
 WHERE grantee = 'sigmadesk_ro' AND table_schema LIKE '\_timescaledb%' GROUP BY 1;
