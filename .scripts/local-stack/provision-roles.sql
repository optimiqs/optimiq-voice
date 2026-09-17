-- Runtime logins for the local end-to-end stack, per docs/native-calling-deployment.md.
--
-- Applied once per database with :role, :password, :database, :tenant_role and :bypassrls bound by
-- up.sh. The three logins are non-superuser and hold no CREATEDB/CREATEROLE. voice_pbx and
-- voice_cdr additionally carry BYPASSRLS and membership in their tenant role, which is what the
-- PBX/CDR admin workers and the request-scoped `set local role` path require today.
--
-- `\gexec` rather than a DO block: psql substitutes :variables in ordinary SQL text but not inside
-- a dollar-quoted body, so a DO block would see the literal `:'role'`.

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role')
\gexec

SELECT format(
	'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE %s',
	:'role', :'password',
	CASE WHEN :'bypassrls' = 'true' THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END
)
\gexec

GRANT CONNECT ON DATABASE :"database" TO :"role";
GRANT USAGE ON SCHEMA public TO :"role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"role";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"role";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"role";
-- The CDR database's partition helpers are SECURITY DEFINER functions the leg writer calls on
-- every boot and every leg, so EXECUTE is as load-bearing as the table DML above.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"role";
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
	GRANT EXECUTE ON FUNCTIONS TO :"role";
GRANT :"tenant_role" TO :"role";
