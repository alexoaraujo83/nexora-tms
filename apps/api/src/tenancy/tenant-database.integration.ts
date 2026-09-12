import { strict as assert } from 'node:assert';

import { TenantDatabaseService } from './tenant-database.service.js';
import { TenantMembershipService } from './tenant-membership.service.js';

const USER_A = '51000000-0000-4000-8000-000000000101';
const TENANT_A = '51000000-0000-4000-8000-000000000001';
const TENANT_B = '51000000-0000-4000-8000-000000000002';

async function run(): Promise<void> {
  const database = new TenantDatabaseService();
  const memberships = new TenantMembershipService(database);

  try {
    const runtimeIdentity = await database.withUserDiscoveryContext(USER_A, async (client) => {
      const result = await client.query<{
        bypass_rls: boolean;
        current_user: string;
        session_user: string;
      }>(
        `SELECT
             current_user::text AS current_user,
             session_user::text AS session_user,
             COALESCE(
               (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
               true
             ) AS bypass_rls`,
      );

      return result.rows[0];
    });

    assert.ok(runtimeIdentity, 'runtime database identity must be observable');
    assert.equal(
      runtimeIdentity.current_user,
      'nexora_app',
      'API transactions must execute as nexora_app',
    );
    assert.equal(
      runtimeIdentity.session_user,
      'nexora_app',
      'API sessions must authenticate as nexora_app',
    );
    assert.equal(
      runtimeIdentity.bypass_rls,
      false,
      'nexora_app must never bypass row-level security',
    );

    const unprotectedTenantTables = await database.withUserDiscoveryContext(
      USER_A,
      async (client) => {
        const result = await client.query<{ table_name: string }>(
          `SELECT c.relname AS table_name
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relkind = 'r'
               AND EXISTS (
                 SELECT 1
                   FROM pg_attribute a
                  WHERE a.attrelid = c.oid
                    AND a.attnum > 0
                    AND NOT a.attisdropped
                    AND a.attname = 'tenant_id'
               )
               AND c.relrowsecurity = false
             ORDER BY c.relname`,
        );
        return result.rows.map((row) => row.table_name);
      },
    );
    assert.deepEqual(
      unprotectedTenantTables,
      [],
      'every public table carrying tenant_id must have PostgreSQL RLS enabled',
    );

    assert.equal(
      await memberships.isActiveMember(USER_A, TENANT_A),
      true,
      'user A must resolve its active tenant A membership',
    );
    assert.equal(
      await memberships.isActiveMember(USER_A, TENANT_B),
      false,
      'user A must not resolve tenant B membership',
    );

    const userOnlyOrganizationCount = await database.withUserDiscoveryContext(
      USER_A,
      async (client) => {
        const result = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM organizations',
        );
        return result.rows[0]?.count ?? -1;
      },
    );
    assert.equal(
      userOnlyOrganizationCount,
      0,
      'user-only discovery context must not expose tenant organizations',
    );

    const tenantAOrganizationCount = await database.withTenantContext(
      {
        subject: 'integration|user-a',
        tenantId: TENANT_A,
        userId: USER_A,
      },
      async (client) => {
        const result = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM organizations',
        );
        return result.rows[0]?.count ?? -1;
      },
    );
    assert.equal(
      tenantAOrganizationCount,
      1,
      'tenant A context must expose exactly tenant A organization',
    );

    const tenantBLeakCount = await database.withTenantContext(
      {
        subject: 'integration|user-a',
        tenantId: TENANT_A,
        userId: USER_A,
      },
      async (client) => {
        const result = await client.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM organizations WHERE tenant_id = $1::uuid',
          [TENANT_B],
        );
        return result.rows[0]?.count ?? -1;
      },
    );
    assert.equal(tenantBLeakCount, 0, 'tenant A context must not read tenant B organization');

    await assert.rejects(
      database.withTenantContext(
        {
          subject: 'integration|user-a',
          tenantId: TENANT_A,
          userId: USER_A,
        },
        async (client) => {
          await client.query(
            `INSERT INTO organizations (tenant_id, code, name)
             VALUES ($1::uuid, 'ILLEGAL-API', 'Illegal API cross-tenant write')`,
            [TENANT_B],
          );
        },
      ),
      (error: unknown) =>
        error instanceof Error && error.message.toLowerCase().includes('row-level security'),
      'tenant A transaction must reject a tenant B write via RLS',
    );
  } finally {
    await database.onModuleDestroy();
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
