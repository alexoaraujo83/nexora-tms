import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';

import type { AuthenticatedHttpRequest } from '../security/authenticated-principal.js';
import { TenantAuthorizationService } from './tenant-authorization.service.js';
import { TenantContextGuard } from './tenant-context.guard.js';
import { TenantContext, type TenantContextSnapshot } from './tenant-context.js';
import type { TenantDatabaseService, TenantQueryClient } from './tenant-database.service.js';
import type { TenantMembershipService } from './tenant-membership.service.js';
import { TenantRuntimeGateController } from './tenant-runtime-gate.controller.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function executionContextFor(request: AuthenticatedHttpRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function membershipService(active: boolean): TenantMembershipService {
  return {
    isActiveMember: async () => active,
  } as unknown as TenantMembershipService;
}

function databaseService(
  rows: Array<{ id: string; slug: string; name: string; status: string }>,
): TenantDatabaseService {
  return {
    withTenantContext: async (
      _context: TenantContextSnapshot,
      work: (client: TenantQueryClient) => Promise<unknown>,
    ) =>
      work({
        query: async () => ({ rows }),
      } as unknown as TenantQueryClient),
  } as unknown as TenantDatabaseService;
}

test('tenant guard establishes context only after active membership validation', async () => {
  const tenantContext = new TenantContext();
  const guard = new TenantContextGuard(membershipService(true), tenantContext);

  const allowed = await guard.canActivate(
    executionContextFor({
      authenticatedPrincipal: {
        subject: 'idp|user-1',
        userId: USER_ID,
      },
      headers: {
        'x-nexora-tenant-id': TENANT_A,
      },
    }),
  );

  assert.equal(allowed, true);
  assert.deepEqual(tenantContext.require(), {
    subject: 'idp|user-1',
    tenantId: TENANT_A,
    userId: USER_ID,
  });
});

test('tenant guard rejects requests without a trusted authenticated principal', async () => {
  const guard = new TenantContextGuard(membershipService(true), new TenantContext());

  await assert.rejects(
    guard.canActivate(
      executionContextFor({
        headers: {
          'x-nexora-tenant-id': TENANT_A,
        },
      }),
    ),
    (error: unknown) => error instanceof UnauthorizedException,
  );
});

test('tenant guard rejects malformed tenant selection before membership lookup', async () => {
  const guard = new TenantContextGuard(membershipService(true), new TenantContext());

  await assert.rejects(
    guard.canActivate(
      executionContextFor({
        authenticatedPrincipal: {
          subject: 'idp|user-1',
          userId: USER_ID,
        },
        headers: {
          'x-nexora-tenant-id': 'not-a-uuid',
        },
      }),
    ),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test('tenant guard rejects ambiguous repeated tenant headers before membership lookup', async () => {
  let membershipChecks = 0;
  const memberships = {
    isActiveMember: async () => {
      membershipChecks += 1;
      return true;
    },
  } as unknown as TenantMembershipService;
  const guard = new TenantContextGuard(memberships, new TenantContext());

  await assert.rejects(
    guard.canActivate(
      executionContextFor({
        authenticatedPrincipal: {
          subject: 'idp|user-1',
          userId: USER_ID,
        },
        headers: {
          'x-nexora-tenant-id': [TENANT_A, TENANT_B],
        },
      }),
    ),
    (error: unknown) => error instanceof BadRequestException,
  );
  assert.equal(membershipChecks, 0);
});

test('tenant guard rejects a selected tenant without an active membership', async () => {
  const guard = new TenantContextGuard(membershipService(false), new TenantContext());

  await assert.rejects(
    guard.canActivate(
      executionContextFor({
        authenticatedPrincipal: {
          subject: 'idp|user-1',
          userId: USER_ID,
        },
        headers: {
          'x-nexora-tenant-id': TENANT_B,
        },
      }),
    ),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test('tenant context cannot be replaced with another tenant during the same request', () => {
  const tenantContext = new TenantContext();
  tenantContext.establish({
    subject: 'idp|user-1',
    tenantId: TENANT_A,
    userId: USER_ID,
  });

  assert.throws(
    () =>
      tenantContext.establish({
        subject: 'idp|user-1',
        tenantId: TENANT_B,
        userId: USER_ID,
      }),
    InternalServerErrorException,
  );
});

test('resource authorization rejects tenant IDs outside the active tenant', () => {
  const tenantContext = new TenantContext();
  tenantContext.establish({
    subject: 'idp|user-1',
    tenantId: TENANT_A,
    userId: USER_ID,
  });

  const authorization = new TenantAuthorizationService(tenantContext);
  assert.doesNotThrow(() => authorization.assertResourceTenant(TENANT_A));
  assert.throws(() => authorization.assertResourceTenant(TENANT_B), ForbiddenException);
});

test('runtime gate succeeds only when RLS exposes the selected tenant', async () => {
  const tenantContext = new TenantContext();
  tenantContext.establish({
    subject: 'idp|user-1',
    tenantId: TENANT_A,
    userId: USER_ID,
  });

  const controller = new TenantRuntimeGateController(
    tenantContext,
    databaseService([
      {
        id: TENANT_A,
        slug: 'tenant-a',
        name: 'Tenant A',
        status: 'active',
      },
    ]),
  );

  assert.deepEqual(await controller.getRuntimeGate(), {
    authenticated: true,
    rlsIsolated: true,
    tenantId: TENANT_A,
    visibleTenant: {
      id: TENANT_A,
      slug: 'tenant-a',
      name: 'Tenant A',
      status: 'active',
    },
  });
});

test('runtime gate fails closed if RLS exposes another tenant', async () => {
  const tenantContext = new TenantContext();
  tenantContext.establish({
    subject: 'idp|user-1',
    tenantId: TENANT_A,
    userId: USER_ID,
  });

  const controller = new TenantRuntimeGateController(
    tenantContext,
    databaseService([
      {
        id: TENANT_A,
        slug: 'tenant-a',
        name: 'Tenant A',
        status: 'active',
      },
      {
        id: TENANT_B,
        slug: 'tenant-b',
        name: 'Tenant B',
        status: 'active',
      },
    ]),
  );

  await assert.rejects(
    controller.getRuntimeGate(),
    (error: unknown) => error instanceof InternalServerErrorException,
  );
});
