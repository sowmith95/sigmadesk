-- OPTIONAL, READ-ONLY report: which functions PUBLIC (therefore every role, sigmadesk_ro included) can execute outside
-- pg_catalog/information_schema, and every SECURITY DEFINER function. It changes nothing.
--   psql -h 127.0.0.1 -p 5433 -U postgres -d trading_ts -f scripts/audit-public-functions.sql
-- Review the list with whoever owns the trading apps. Revoking EXECUTE from PUBLIC can break application roles that
-- rely on it: if you decide to revoke something, first GRANT EXECUTE explicitly to each application role that uses it,
-- test, and only then REVOKE ... FROM PUBLIC — by hand, as its own reviewed change. SigmaDesk never does this for you.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
\echo '== functions PUBLIC can execute (outside pg_catalog/information_schema), and SECURITY DEFINER functions'
SELECT n.nspname AS schema, p.proname AS function, pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner,
       CASE p.provolatile WHEN 'v' THEN 'volatile' WHEN 's' THEN 'stable' ELSE 'immutable' END AS volatility
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
       LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
   AND (n.nspname NOT IN ('pg_catalog', 'information_schema') OR p.prosecdef)
   AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
 ORDER BY p.prosecdef DESC, 1, 2
 LIMIT 500;
\echo '== extensions that can reach other servers or the filesystem (review who may use them)'
SELECT extname, extversion FROM pg_extension WHERE extname IN ('dblink', 'postgres_fdw', 'file_fdw', 'adminpack', 'pg_read_server_files') ORDER BY 1;
ROLLBACK;
