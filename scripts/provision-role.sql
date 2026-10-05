-- SigmaDesk production read access: provision the read-only role the DESK (never a seat) uses for `desk ops` probes.
--
-- The OWNER runs this by hand, as a superuser, per database. DRY RUN FIRST (everything, then ROLLBACK):
--   psql -X -U postgres -h 127.0.0.1 -p 5433 -d trading_ts -v ON_ERROR_STOP=1 -v dry_run=1 -f scripts/provision-role.sql
-- then for real (same command without -v dry_run=1):
--   psql -X -U postgres -h 127.0.0.1 -p 5433 -d trading_ts -v ON_ERROR_STOP=1 -f scripts/provision-role.sql
-- and the app database the same way with -p 5434 -d trading_app (it has no Timescale tables; the freshness function is
-- then created over the approved tables that exist there, i.e. none, and returns no rows).
-- Then set the password interactively (never in a file the desk config or a seat can read):  \password sigmadesk_ro
-- and store it in the desk's pgpass file (chmod 600), e.g. ~/.pgpass-sigmadesk:
--   127.0.0.1:5433:trading_ts:sigmadesk_ro:<password>
--
-- Design: sigmadesk_ro holds NO privileges on any hypertable (column grants on compressed/columnstore hypertables are
-- propagated by Timescale to the compressed hypertable, whose columns differ, and fail; they also meant one ACL update
-- per chunk). Instead:
--   * sigmadesk_ops_owner: a NOLOGIN role with table-level SELECT on exactly the approved relations (Timescale
--     propagates table-level grants to chunks and to the compressed hypertable — no column names involved);
--   * schema sigmadesk_ops, owned by sigmadesk_ops_owner, holding one function: ingest_freshness(p_minutes int),
--     SECURITY DEFINER, search_path = pg_catalog, pg_temp, p_minutes clamped to 1..1440, fixed queries with half-open
--     windows on each table's time column; EXECUTE revoked from PUBLIC and granted to sigmadesk_ro only;
--   * sigmadesk_ro: LOGIN, read-only by default, tight defaults; pg_read_all_stats; CONNECT; USAGE on sigmadesk_ops and
--     timescaledb_information; SELECT on four Timescale information views; EXECUTE on that one function. Nothing else.
-- It NEVER changes PUBLIC privileges on anything but its own function, and never touches other roles.
-- It ABORTS, changing nothing, if either role (or the schema) already holds anything beyond that reviewed set.
--
-- Runtime: GRANT SELECT on a hypertable is propagated to every chunk and to the compressed hypertable and its chunks
-- (one ACL catalog update each, catalog row locks only; no table rewrite). With ~2,400 chunks expect seconds to a few
-- tens of seconds. Everything is ONE transaction with lock_timeout 2s and statement_timeout 120s: on a timeout or any
-- error, everything rolls back. Re-running is safe: the preflight accepts exactly what this script grants, every GRANT
-- is idempotent, and the function is CREATE OR REPLACE.
\set ON_ERROR_STOP 1
\echo '== server and TimescaleDB versions'
SELECT current_setting('server_version') AS postgres, (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS timescaledb;
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

-- The reviewed sources, in one place: what the function reads. (label, relation in public, time column, optional
-- equality filter). Keep labels in step with ops.freshness in the desk config.
CREATE TEMP TABLE sigmadesk_sources (label text, rel text, col text, filter_col text, filter_val text) ON COMMIT DROP;
INSERT INTO sigmadesk_sources VALUES
  ('bar_ticks 1s', 'bar_ticks', 'timestamp', 'timeframe', '1s'),
  ('bar_ticks_1s', 'bar_ticks_1s', 'timestamp', NULL, NULL),
  ('whale_trades', 'whale_trades', 'timestamp', NULL, NULL),
  ('bars_1m', 'bars_1m', 'bucket', NULL, NULL);
DELETE FROM sigmadesk_sources WHERE to_regclass('public.' || quote_ident(rel)) IS NULL; -- absent here: skipped

-- Every relation a table-level grant on those sources may legitimately land on: the public relations, the chunks of
-- approved hypertables, their compressed hypertables and chunks, and for a continuous aggregate its direct and partial
-- views and its materialization hypertable (plus that hypertable's compressed hypertable and all their chunks).
CREATE TEMP TABLE sigmadesk_family (relid oid) ON COMMIT DROP;
INSERT INTO sigmadesk_family SELECT to_regclass('public.' || quote_ident(rel)) FROM sigmadesk_sources;
CREATE TEMP TABLE sigmadesk_ht (id int) ON COMMIT DROP;
DO $$
BEGIN
  IF to_regclass('_timescaledb_catalog.hypertable') IS NULL THEN RETURN; END IF;
  INSERT INTO sigmadesk_ht SELECT h.id FROM _timescaledb_catalog.hypertable h WHERE h.schema_name = 'public' AND h.table_name IN (SELECT rel FROM sigmadesk_sources);
  -- Continuous aggregates: the internal catalog (TimescaleDB 2.25: direct/partial view and mat_hypertable_id columns),
  -- or an information view that exposes the same names. Neither: abort before any change.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname IN (SELECT rel FROM sigmadesk_sources)) THEN
    IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = '_timescaledb_catalog' AND table_name = 'continuous_agg'
          AND column_name IN ('user_view_schema', 'user_view_name', 'direct_view_schema', 'direct_view_name', 'partial_view_schema', 'partial_view_name', 'mat_hypertable_id')) = 7 THEN
      EXECUTE $q$CREATE TEMP TABLE sigmadesk_caggs ON COMMIT DROP AS
        SELECT ca.user_view_name::text AS parent, ca.direct_view_schema::text AS dschema, ca.direct_view_name::text AS dname,
               ca.partial_view_schema::text AS pschema, ca.partial_view_name::text AS pname, ca.mat_hypertable_id AS mat_id
          FROM _timescaledb_catalog.continuous_agg ca
         WHERE ca.user_view_schema = 'public' AND ca.user_view_name IN (SELECT rel FROM sigmadesk_sources)$q$;
    ELSIF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'timescaledb_information' AND table_name = 'continuous_aggregates'
          AND column_name IN ('view_schema', 'view_name', 'direct_view_schema', 'direct_view_name', 'partial_view_schema', 'partial_view_name', 'materialization_hypertable_schema', 'materialization_hypertable_name')) = 8 THEN
      EXECUTE $q$CREATE TEMP TABLE sigmadesk_caggs ON COMMIT DROP AS
        SELECT v.view_name::text AS parent, v.direct_view_schema::text AS dschema, v.direct_view_name::text AS dname,
               v.partial_view_schema::text AS pschema, v.partial_view_name::text AS pname, h.id AS mat_id
          FROM timescaledb_information.continuous_aggregates v
          JOIN _timescaledb_catalog.hypertable h ON h.schema_name = v.materialization_hypertable_schema AND h.table_name = v.materialization_hypertable_name
         WHERE v.view_schema = 'public' AND v.view_name IN (SELECT rel FROM sigmadesk_sources)$q$;
    ELSE
      RAISE EXCEPTION 'cannot find continuous-aggregate direct/partial view names in this TimescaleDB catalog; nothing was changed';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v'
               AND c.relname IN (SELECT rel FROM sigmadesk_sources) AND c.relname NOT IN (SELECT parent FROM sigmadesk_caggs)) THEN
      RAISE EXCEPTION 'an approved view is not a continuous aggregate this script understands; nothing was changed';
    END IF;
    INSERT INTO sigmadesk_family
      SELECT to_regclass(format('%I.%I', dschema, dname)) FROM sigmadesk_caggs WHERE to_regclass(format('%I.%I', dschema, dname)) IS NOT NULL
      UNION ALL
      SELECT to_regclass(format('%I.%I', pschema, pname)) FROM sigmadesk_caggs WHERE to_regclass(format('%I.%I', pschema, pname)) IS NOT NULL;
    INSERT INTO sigmadesk_ht SELECT mat_id FROM sigmadesk_caggs;
  END IF;
  -- compressed (columnstore) hypertables of everything above
  INSERT INTO sigmadesk_ht SELECT h.compressed_hypertable_id FROM _timescaledb_catalog.hypertable h
   WHERE h.id IN (SELECT id FROM sigmadesk_ht) AND h.compressed_hypertable_id IS NOT NULL;
  INSERT INTO sigmadesk_family
    SELECT to_regclass(format('%I.%I', h.schema_name, h.table_name)) FROM _timescaledb_catalog.hypertable h
     WHERE h.id IN (SELECT id FROM sigmadesk_ht) AND to_regclass(format('%I.%I', h.schema_name, h.table_name)) IS NOT NULL
    UNION ALL
    SELECT to_regclass(format('%I.%I', ch.schema_name, ch.table_name)) FROM _timescaledb_catalog.chunk ch
     WHERE ch.hypertable_id IN (SELECT id FROM sigmadesk_ht) AND to_regclass(format('%I.%I', ch.schema_name, ch.table_name)) IS NOT NULL;
END $$;

-- 0. Preflight: read existing privileges from the catalogs' own ACLs. Anything beyond the reviewed set aborts here.
DO $$
DECLARE ro oid; ow oid; sch oid; fn oid; bad text := ''; x text;
BEGIN
  SELECT oid INTO ro FROM pg_roles WHERE rolname = 'sigmadesk_ro';
  SELECT oid INTO ow FROM pg_roles WHERE rolname = 'sigmadesk_ops_owner';
  SELECT oid INTO sch FROM pg_namespace WHERE nspname = 'sigmadesk_ops';
  IF sch IS NOT NULL THEN fn := to_regprocedure('sigmadesk_ops.ingest_freshness(integer)'); END IF;

  -- the schema: owned by sigmadesk_ops_owner, holds only the one function, no default privileges
  IF sch IS NOT NULL THEN
    IF ow IS NULL OR (SELECT nspowner FROM pg_namespace WHERE oid = sch) <> ow THEN bad := bad || E'\n  - schema sigmadesk_ops exists but is not owned by sigmadesk_ops_owner'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = sch) OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = sch AND oid IS DISTINCT FROM fn) THEN
      bad := bad || E'\n  - schema sigmadesk_ops holds objects other than ingest_freshness(integer)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_default_acl WHERE defaclnamespace = sch) THEN bad := bad || E'\n  - default privileges on schema sigmadesk_ops'; END IF;
    SELECT string_agg(DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type, ', ') INTO x
      FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
     WHERE n.oid = sch AND a.grantee IS DISTINCT FROM ow AND (ro IS NULL OR a.grantee <> ro OR a.privilege_type <> 'USAGE');
    IF x IS NOT NULL THEN bad := bad || E'\n  - unexpected privileges on schema sigmadesk_ops: ' || x; END IF;
  END IF;
  IF fn IS NOT NULL THEN
    IF ow IS NULL OR (SELECT proowner FROM pg_proc WHERE oid = fn) <> ow THEN bad := bad || E'\n  - sigmadesk_ops.ingest_freshness is not owned by sigmadesk_ops_owner'; END IF;
    SELECT string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type, ', ') INTO x
      FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn AND a.grantee IS DISTINCT FROM ow AND (ro IS NULL OR a.grantee <> ro);
    IF x IS NOT NULL THEN bad := bad || E'\n  - ingest_freshness is executable by: ' || x; END IF;
  END IF;

  -- sigmadesk_ops_owner: NOLOGIN, nothing powerful, no memberships, owns only the schema and its function,
  -- table-level SELECT only on the approved family, nothing else
  IF ow IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = ow AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
      bad := bad || E'\n  - sigmadesk_ops_owner can log in or has dangerous attributes';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = ow OR roleid = ow) THEN bad := bad || E'\n  - sigmadesk_ops_owner has memberships or members'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = ow) OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = ow AND oid IS DISTINCT FROM fn)
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = ow AND oid IS DISTINCT FROM sch) OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = ow)
       OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = ow AND typrelid = 0) THEN
      bad := bad || E'\n  - sigmadesk_ops_owner owns objects other than its schema and function';
    END IF;
    SELECT string_agg(DISTINCT c.oid::regclass::text || ' ' || a.privilege_type, ', ') INTO x
      FROM pg_class c, LATERAL aclexplode(c.relacl) a
     WHERE a.grantee = ow AND NOT (a.privilege_type = 'SELECT' AND c.oid IN (SELECT relid FROM sigmadesk_family));
    IF x IS NOT NULL THEN bad := bad || E'\n  - sigmadesk_ops_owner table privileges beyond the approved relations: ' || left(x, 400); END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute at, LATERAL aclexplode(at.attacl) a WHERE a.grantee = ow) THEN bad := bad || E'\n  - sigmadesk_ops_owner has column privileges'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE a.grantee = ow AND p.proowner <> ow) THEN bad := bad || E'\n  - sigmadesk_ops_owner has function privileges'; END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE a.grantee = ow AND n.nspowner <> ow AND NOT (a.privilege_type = 'USAGE' AND n.nspname = 'public')) THEN
      bad := bad || E'\n  - sigmadesk_ops_owner schema privileges beyond USAGE on public';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_database d, LATERAL aclexplode(d.datacl) a WHERE a.grantee = ow) THEN bad := bad || E'\n  - sigmadesk_ops_owner has database privileges'; END IF;
    IF EXISTS (SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a WHERE a.grantee = ow OR d.defaclrole = ow) THEN bad := bad || E'\n  - default privileges involving sigmadesk_ops_owner'; END IF;
  END IF;

  -- sigmadesk_ro: statistics membership (no ADMIN OPTION), CONNECT, USAGE on sigmadesk_ops/timescaledb_information,
  -- SELECT on four information views, EXECUTE on the one function. No table, column or other function privilege.
  IF ro IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = ro AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
      bad := bad || E'\n  - sigmadesk_ro has dangerous role attributes';
    END IF;
    SELECT string_agg(g.rolname || CASE WHEN m.admin_option THEN ' (WITH ADMIN OPTION)' ELSE '' END, ', ') INTO x
      FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = ro AND (g.rolname <> 'pg_read_all_stats' OR m.admin_option);
    IF x IS NOT NULL THEN bad := bad || E'\n  - sigmadesk_ro unexpected memberships: ' || x; END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = ro) THEN bad := bad || E'\n  - other roles are members of sigmadesk_ro'; END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relowner = ro) OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = ro)
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = ro) OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = ro)
       OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = ro AND typrelid = 0) THEN
      bad := bad || E'\n  - sigmadesk_ro owns objects';
    END IF;
    SELECT string_agg(DISTINCT n.nspname || '.' || c.relname || ' ' || a.privilege_type, ', ') INTO x
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
     WHERE a.grantee = ro AND NOT (n.nspname = 'timescaledb_information' AND c.relname IN ('jobs', 'job_stats', 'job_errors', 'continuous_aggregates') AND a.privilege_type = 'SELECT');
    IF x IS NOT NULL THEN bad := bad || E'\n  - sigmadesk_ro table privileges beyond the reviewed views: ' || left(x, 400); END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute at, LATERAL aclexplode(at.attacl) a WHERE a.grantee = ro) THEN bad := bad || E'\n  - sigmadesk_ro has column privileges'; END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a WHERE a.grantee = ro AND p.oid IS DISTINCT FROM fn) THEN bad := bad || E'\n  - sigmadesk_ro has other function privileges'; END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a WHERE a.grantee = ro AND NOT (a.privilege_type = 'USAGE' AND n.nspname IN ('sigmadesk_ops', 'timescaledb_information'))) THEN
      bad := bad || E'\n  - sigmadesk_ro schema privileges beyond USAGE on sigmadesk_ops/timescaledb_information';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_database d, LATERAL aclexplode(d.datacl) a WHERE a.grantee = ro AND a.privilege_type <> 'CONNECT') THEN bad := bad || E'\n  - sigmadesk_ro database privileges beyond CONNECT'; END IF;
    IF EXISTS (SELECT 1 FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a WHERE a.grantee = ro OR d.defaclrole = ro) THEN bad := bad || E'\n  - default privileges involving sigmadesk_ro'; END IF;
  END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION 'existing SigmaDesk roles/schema hold privileges outside the reviewed set; nothing was changed:%', bad;
  END IF;
END $$;

-- 1. Roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sigmadesk_ops_owner') THEN
    CREATE ROLE sigmadesk_ops_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
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
-- Session statistics (pg_stat_activity/replication for other sessions).
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE 'GRANT pg_read_all_stats TO sigmadesk_ro WITH INHERIT TRUE';
  ELSE
    EXECUTE 'ALTER ROLE sigmadesk_ro INHERIT';
    EXECUTE 'GRANT pg_read_all_stats TO sigmadesk_ro';
  END IF;
END $$;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO sigmadesk_ro', current_database()); END $$;

-- 2. The function's owner reads exactly the approved relations (table-level SELECT; Timescale propagates it).
GRANT USAGE ON SCHEMA public TO sigmadesk_ops_owner;
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT DISTINCT rel FROM sigmadesk_sources LOOP
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO sigmadesk_ops_owner', g.rel);
  END LOOP;
END $$;

-- 3. Schema + SECURITY DEFINER function, generated from sigmadesk_sources. Fixed text; p_minutes clamped to 1..1440.
CREATE SCHEMA IF NOT EXISTS sigmadesk_ops AUTHORIZATION sigmadesk_ops_owner;
REVOKE ALL ON SCHEMA sigmadesk_ops FROM PUBLIC;
-- Distinct dollar-quote tags at each level ($gen$ > $f$ > $body$): an inner tag must never form '$$' with its neighbour.
DO $gen$
DECLARE body text;
BEGIN
  SELECT string_agg(format(
      'SELECT %L::text, max(t.%I)::timestamptz, now() - max(t.%I)::timestamptz FROM public.%I t WHERE t.%I >= now() - make_interval(mins => m) AND t.%I < now() + interval %L%s',
      label, col, col, rel, col, col, '5 minutes', CASE WHEN filter_col IS NULL THEN '' ELSE format(' AND t.%I = %L', filter_col, filter_val) END),
    E'\n      UNION ALL\n      ' ORDER BY label) INTO body FROM sigmadesk_sources;
  IF body IS NULL THEN body := 'SELECT NULL::text, NULL::timestamptz, NULL::interval WHERE false'; END IF;
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION sigmadesk_ops.ingest_freshness(p_minutes integer)
    RETURNS TABLE (label text, last_ts timestamptz, lag interval)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $body$
    DECLARE m integer := least(greatest(coalesce(p_minutes, 120), 1), 1440);
    BEGIN
      RETURN QUERY
      %s;
    END
    $body$
    $f$, body);
END $gen$;
ALTER FUNCTION sigmadesk_ops.ingest_freshness(integer) OWNER TO sigmadesk_ops_owner;
REVOKE ALL ON FUNCTION sigmadesk_ops.ingest_freshness(integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA sigmadesk_ops TO sigmadesk_ro;
GRANT EXECUTE ON FUNCTION sigmadesk_ops.ingest_freshness(integer) TO sigmadesk_ro;

-- 4. Timescale job/aggregate metadata (timescale_jobs).
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

-- 5. Self-check, as sigmadesk_ro, inside this transaction: the function answers (5-minute window: cheap).
SET LOCAL ROLE sigmadesk_ro;
\echo '== self-check as sigmadesk_ro: sigmadesk_ops.ingest_freshness(5)'
SELECT * FROM sigmadesk_ops.ingest_freshness(5);
RESET ROLE;

\echo '== sigmadesk_ro and sigmadesk_ops_owner now hold:'
SELECT rolname, rolsuper, rolinherit, rolcanlogin, rolconnlimit, rolconfig FROM pg_roles WHERE rolname IN ('sigmadesk_ro', 'sigmadesk_ops_owner') ORDER BY 1;
SELECT u.rolname AS role, g.rolname AS member_of, m.admin_option FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname IN ('sigmadesk_ro', 'sigmadesk_ops_owner');
SELECT grantee, table_schema, table_name, privilege_type FROM information_schema.role_table_grants
 WHERE grantee IN ('sigmadesk_ro', 'sigmadesk_ops_owner') AND table_schema NOT LIKE '\_timescaledb%' ORDER BY 1, 2, 3;
SELECT grantee, table_schema, count(DISTINCT table_name) AS propagated_relations FROM information_schema.role_table_grants
 WHERE grantee IN ('sigmadesk_ro', 'sigmadesk_ops_owner') AND table_schema LIKE '\_timescaledb%' GROUP BY 1, 2;
SELECT p.oid::regprocedure AS function, p.prosecdef AS security_definer, p.proconfig, p.proacl FROM pg_proc p WHERE p.oid = 'sigmadesk_ops.ingest_freshness(integer)'::regprocedure;

\if :{?dry_run}
\echo '== DRY RUN (-v dry_run=...): rolling everything back; nothing was changed'
ROLLBACK;
\else
COMMIT;
\echo '== committed'
\endif
