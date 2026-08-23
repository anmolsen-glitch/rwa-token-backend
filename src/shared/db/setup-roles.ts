/**
 * Creates the LOGIN roles that the app authenticates as.
 *
 * Kept OUT of migrations on purpose: migrations are committed to git, and a
 * CREATE ROLE … PASSWORD line in a tracked file is a leaked credential. This
 * script reads the passwords from the environment and is safe to re-run.
 *
 *   APP_TENANT_PASSWORD=… APP_WORKER_PASSWORD=… npm run db:setup-roles
 *
 * Run it AFTER migration 042 (which creates the app_tenant / app_worker group
 * roles and the policies), then point DATABASE_URL at app_tenant_login.
 *
 * Must be run as a superuser-ish role — i.e. the Supabase `postgres` user, which
 * is what DATABASE_URL currently is.
 */
import { Pool } from 'pg';
import 'dotenv/config';

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_ADMIN_URL (or DATABASE_URL) to an owner connection');

  const tenantPw = process.env.APP_TENANT_PASSWORD;
  const workerPw = process.env.APP_WORKER_PASSWORD;
  if (!tenantPw || !workerPw) {
    throw new Error('Set APP_TENANT_PASSWORD and APP_WORKER_PASSWORD (min 24 chars each)');
  }
  if (tenantPw.length < 24 || workerPw.length < 24) {
    throw new Error('Role passwords must be at least 24 characters');
  }

  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 2,
  });

  const roles: Array<{ login: string; group: string; password: string }> = [
    { login: 'app_tenant_login', group: 'app_tenant', password: tenantPw },
    { login: 'app_worker_login', group: 'app_worker', password: workerPw },
  ];

  for (const { login, group, password } of roles) {
    const { rows } = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login]);

    /*
     * CREATE/ALTER ROLE accepts no bind parameters, and neither does a DO block,
     * so the statement has to be assembled as text. Two safeguards:
     *   - role names are hardcoded literals in this file, never user input;
     *   - the password is escaped as a SQL string literal (double any quote).
     * Anything else here would be an injection point.
     */
    const lit = `'${password.replace(/'/g, "''")}'`;
    if (!/^[a-z_]+$/.test(login)) throw new Error(`Refusing unexpected role name: ${login}`);

    if (rows.length === 0) {
      await pool.query(`CREATE ROLE ${login} LOGIN PASSWORD ${lit}`);
      console.log(`[roles] created ${login}`);
    } else {
      await pool.query(`ALTER ROLE ${login} LOGIN PASSWORD ${lit}`);
      console.log(`[roles] updated password for ${login}`);
    }

    await pool.query(`GRANT ${group} TO ${login}`);

    /*
     * Role ATTRIBUTES (BYPASSRLS, SUPERUSER, CREATEDB) are NOT inherited through
     * role membership — only privileges granted with GRANT are. So being a
     * member of app_worker does not give app_worker_login its BYPASSRLS; it has
     * to be set on the login role itself.
     *
     * Getting this backwards fails in opposite directions: the worker silently
     * reads nothing (auth breaks loudly), while a tenant role that wrongly had
     * BYPASSRLS would silently read everything (nothing breaks at all — the
     * far more dangerous case).
     */
    if (group === 'app_worker') {
      await pool.query(`ALTER ROLE ${login} BYPASSRLS`);
    } else {
      await pool.query(`ALTER ROLE ${login} NOBYPASSRLS`);
    }

    const { rows: check } = await pool.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
      [login],
    );
    const expected = group === 'app_worker';
    if (check[0]?.rolbypassrls !== expected) {
      throw new Error(
        `${login} rolbypassrls=${String(check[0]?.rolbypassrls)}, expected ${String(expected)}`,
      );
    }
    console.log(`[roles] ${login}: member of ${group}, bypassrls=${String(expected)}`);
  }

  console.log('\n[roles] done. Now set in .env:');
  console.log('  DATABASE_URL        -> …postgres.<ref>:<pw>@…  with user app_tenant_login');
  console.log('  DATABASE_WORKER_URL -> same host, user app_worker_login');
  await pool.end();
}

main().catch((err: unknown) => {
  console.error('[roles] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
