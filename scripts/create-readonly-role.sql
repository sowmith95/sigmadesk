-- SigmaDesk production read access: the read-only role the DESK (never a seat) uses for `desk ops` probes.
--
-- The OWNER runs this by hand, as a superuser, once per database server (roles are per cluster):
--   psql -h 127.0.0.1 -p 5433 -U postgres -d trading_ts  -f scripts/create-readonly-role.sql
--   psql -h 127.0.0.1 -p 5434 -U postgres -d trading_app -f scripts/create-readonly-role.sql
-- then sets a password interactively (it never goes into a file the desk config or a seat can read):
--   \password sigmadesk_ro
-- and puts it in the desk's pgpass file (chmod 600), e.g. ~/.pgpass-sigmadesk:
--   127.0.0.1:5433:trading_ts:sigmadesk_ro:<password>
--   127.0.0.1:5434:trading_app:sigmadesk_ro:<password>
--
-- Safe to re-run. It creates a NON-owner login role that is read-only by default, grants only the catalog views and
-- the reviewed table columns the probes read, and ends by printing what PUBLIC can still execute for you to review.
\set ON_ERROR_STOP 1

-- 1. The role: login, no inheritance of anything powerful, read-only by default, few connections, tight defaults.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sigmadesk_ro') THEN
    CREATE ROLE sigmadesk_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
  ELSE
    ALTER ROLE sigmadesk_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
  END IF;
END $$;
ALTER ROLE sigmadesk_ro SET default_transaction_read_only = on;
ALTER ROLE sigmadesk_ro SET statement_timeout = '15s';
ALTER ROLE sigmadesk_ro SET lock_timeout = '1s';
ALTER ROLE sigmadesk_ro SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE sigmadesk_ro SET work_mem = '4MB';
ALTER ROLE sigmadesk_ro SET max_parallel_workers_per_gather = 0;
ALTER ROLE sigmadesk_ro SET temp_file_limit = '64MB';

-- Every probe runs `SET LOCAL temp_file_limit` inside its read-only transaction; that parameter needs an explicit
-- SET privilege (PostgreSQL 15+). On older servers the role default above applies and the desk's SET LOCAL fails:
-- upgrade, or the probes will report the error.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    EXECUTE 'GRANT SET ON PARAMETER temp_file_limit TO sigmadesk_ro';
  ELSE
    RAISE WARNING 'PostgreSQL < 15: cannot GRANT SET ON PARAMETER temp_file_limit; desk ops DB probes will fail here';
  END IF;
END $$;

-- 2. Session/lock/replication STATISTICS (not data): needed to see other sessions' state in pg_stat_activity and
-- pg_stat_replication. The probes never select query text; this role is only used by the desk's fixed templates.
GRANT pg_read_all_stats TO sigmadesk_ro;

-- 3. Connect to this database; read only what the probes read.
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO sigmadesk_ro', current_database()); END $$;
GRANT USAGE ON SCHEMA public TO sigmadesk_ro;

-- Timescale job/aggregate metadata (timescale_jobs). Present only where the extension is installed.
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

-- Reviewed columns for ingest_freshness: the partition/time column (and the timeframe filter) only — never prices,
-- sizes, symbols or anything else. Edit this list to match ops.freshness in the desk config; missing tables are skipped.
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT * FROM (VALUES
      ('public.bar_ticks',    'timestamp, timeframe'),
      ('public.bar_ticks_1s', 'timestamp'),
      ('public.whale_trades', 'timestamp'),
      ('public.bars_1m',      'bucket')
    ) AS t(rel, cols)
  LOOP
    IF to_regclass(g.rel) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON %s TO sigmadesk_ro',
        (SELECT string_agg(quote_ident(trim(c)), ', ') FROM unnest(string_to_array(g.cols, ',')) AS c), g.rel);
    END IF;
  END LOOP;
END $$;

-- 4. Risky functions PUBLIC can execute, revoked where that cannot break the trading apps:
--    dblink/postgres_fdw connection functions (reach other servers) if those extensions are installed.
--    pg_sleep* and large-object functions are left alone: an application may use them. Review the audit below.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname IN ('dblink_connect', 'dblink_connect_u', 'dblink', 'dblink_exec', 'dblink_send_query')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;

-- 5. What the new role can reach, and what PUBLIC (therefore every role, sigmadesk_ro included) can still execute
-- outside pg_catalog — or anywhere with SECURITY DEFINER. Review these lists; revoke what your apps do not need.
\echo '== sigmadesk_ro: table/column privileges'
SELECT table_schema, table_name, string_agg(DISTINCT column_name, ', ') AS columns
  FROM information_schema.column_privileges WHERE grantee = 'sigmadesk_ro' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'sigmadesk_ro' ORDER BY 1, 2;
\echo '== sigmadesk_ro: role settings and memberships'
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'sigmadesk_ro';
SELECT r.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'sigmadesk_ro';
\echo '== functions PUBLIC can execute (outside pg_catalog/information_schema, or SECURITY DEFINER)'
SELECT n.nspname AS schema, p.proname AS function, pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer, CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable' ELSE 'immutable' END AS volatility
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
       LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
   AND (n.nspname NOT IN ('pg_catalog', 'information_schema') OR p.prosecdef)
   AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
 ORDER BY p.prosecdef DESC, 1, 2
 LIMIT 300;
