import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { TenantContext } from '../tenancy/tenant-context.js';
import {
  TenantDatabaseService,
  type TenantQueryClient,
} from '../tenancy/tenant-database.service.js';
import {
  assertPlannedWindow,
  parseCreateTransportRequest,
  parseUpdateTransportRequest,
  requireUuid,
  type TransportRequestStatus,
} from './transport-request.validation.js';

export interface TransportRequest {
  readonly id: string;
  readonly customerPartyId: string;
  readonly shipperPartyId: string;
  readonly consigneePartyId: string;
  readonly originAddressId: string;
  readonly destinationAddressId: string;
  readonly plannedPickupAt: string;
  readonly plannedDeliveryAt: string;
  readonly cargoDescription: string;
  readonly status: TransportRequestStatus;
  readonly createdByUserId: string;
  readonly updatedByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TransportRequestRow {
  readonly id: string;
  readonly customer_party_id: string;
  readonly shipper_party_id: string;
  readonly consignee_party_id: string;
  readonly origin_address_id: string;
  readonly destination_address_id: string;
  readonly planned_pickup_at: Date;
  readonly planned_delivery_at: Date;
  readonly cargo_description: string;
  readonly status: TransportRequestStatus;
  readonly created_by_user_id: string;
  readonly updated_by_user_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface PartyReferenceRow {
  readonly status: 'active' | 'inactive';
  readonly has_role: boolean;
}

const requestSelect = `
  SELECT
    id::text AS id,
    customer_party_id::text AS customer_party_id,
    shipper_party_id::text AS shipper_party_id,
    consignee_party_id::text AS consignee_party_id,
    origin_address_id::text AS origin_address_id,
    destination_address_id::text AS destination_address_id,
    planned_pickup_at,
    planned_delivery_at,
    cargo_description,
    status::text AS status,
    created_by_user_id::text AS created_by_user_id,
    updated_by_user_id::text AS updated_by_user_id,
    created_at,
    updated_at
  FROM transport_requests
`;

@Injectable()
export class TransportRequestService {
  constructor(
    private readonly tenantContext: TenantContext,
    private readonly database: TenantDatabaseService,
  ) {}

  async list(): Promise<readonly TransportRequest[]> {
    const context = this.tenantContext.require();
    return this.database.withTenantContext(context, async (client) => {
      const result = await client.query<TransportRequestRow>(`${requestSelect}
        ORDER BY planned_pickup_at, created_at, id`);
      return result.rows.map(mapTransportRequest);
    });
  }

  async getById(id: string): Promise<TransportRequest> {
    const requestId = requireUuid(id);
    const context = this.tenantContext.require();
    return this.database.withTenantContext(context, async (client) => {
      return this.requireRequest(client, requestId);
    });
  }

  async create(input: unknown): Promise<TransportRequest> {
    const data = parseCreateTransportRequest(input);
    const context = this.tenantContext.require();

    return this.database.withTenantContext(context, async (client) => {
      await this.assertReferences(client, data);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO transport_requests (
           tenant_id,
           customer_party_id,
           shipper_party_id,
           consignee_party_id,
           origin_address_id,
           destination_address_id,
           planned_pickup_at,
           planned_delivery_at,
           cargo_description,
           status,
           created_by_user_id,
           updated_by_user_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::timestamptz, $8::timestamptz, $9, $10::transport_request_status,
           $11::uuid, $11::uuid
         )
         RETURNING id::text AS id`,
        [
          context.tenantId,
          data.customerPartyId,
          data.shipperPartyId,
          data.consigneePartyId,
          data.originAddressId,
          data.destinationAddressId,
          data.plannedPickupAt,
          data.plannedDeliveryAt,
          data.cargoDescription,
          data.status,
          context.userId,
        ],
      );

      return this.requireRequest(client, inserted.rows[0]!.id);
    });
  }

  async update(id: string, input: unknown): Promise<TransportRequest> {
    const requestId = requireUuid(id);
    const patch = parseUpdateTransportRequest(input);
    const context = this.tenantContext.require();

    return this.database.withTenantContext(context, async (client) => {
      const before = await this.requireRequest(client, requestId);
      if (before.status === 'contracted' || before.status === 'cancelled') {
        throw new ConflictException(
          `Transport request cannot be edited while status is ${before.status}`,
        );
      }
      if (
        patch.status !== undefined &&
        before.status !== 'draft' &&
        before.status !== 'ready_for_quote'
      ) {
        throw new ConflictException(
          'Lifecycle status is controlled by negotiation after ready_for_quote',
        );
      }

      const merged = {
        customerPartyId: patch.customerPartyId ?? before.customerPartyId,
        shipperPartyId: patch.shipperPartyId ?? before.shipperPartyId,
        consigneePartyId: patch.consigneePartyId ?? before.consigneePartyId,
        originAddressId: patch.originAddressId ?? before.originAddressId,
        destinationAddressId: patch.destinationAddressId ?? before.destinationAddressId,
        plannedPickupAt: patch.plannedPickupAt ?? new Date(before.plannedPickupAt),
        plannedDeliveryAt: patch.plannedDeliveryAt ?? new Date(before.plannedDeliveryAt),
        cargoDescription: patch.cargoDescription ?? before.cargoDescription,
        status: patch.status ?? before.status,
      };

      assertPlannedWindow(merged.plannedPickupAt, merged.plannedDeliveryAt);
      if (merged.originAddressId === merged.destinationAddressId) {
        throw new BadRequestException('originAddressId and destinationAddressId must be different');
      }
      await this.assertReferences(client, merged);

      const updated = await client.query(
        `UPDATE transport_requests
            SET customer_party_id = $2::uuid,
                shipper_party_id = $3::uuid,
                consignee_party_id = $4::uuid,
                origin_address_id = $5::uuid,
                destination_address_id = $6::uuid,
                planned_pickup_at = $7::timestamptz,
                planned_delivery_at = $8::timestamptz,
                cargo_description = $9,
                status = $10::transport_request_status,
                updated_by_user_id = $11::uuid,
                updated_at = now()
          WHERE id = $1::uuid
            AND updated_at = $12::timestamptz`,
        [
          requestId,
          merged.customerPartyId,
          merged.shipperPartyId,
          merged.consigneePartyId,
          merged.originAddressId,
          merged.destinationAddressId,
          merged.plannedPickupAt,
          merged.plannedDeliveryAt,
          merged.cargoDescription,
          merged.status,
          context.userId,
          before.updatedAt,
        ],
      );

      if (updated.rowCount !== 1) {
        throw new ConflictException(
          'Transport request was modified concurrently; reload it and retry the update',
        );
      }

      return this.requireRequest(client, requestId);
    });
  }

  private async requireRequest(
    client: TenantQueryClient,
    requestId: string,
  ): Promise<TransportRequest> {
    const result = await client.query<TransportRequestRow>(`${requestSelect} WHERE id = $1::uuid`, [
      requestId,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('Transport request not found in current tenant');
    }
    return mapTransportRequest(row);
  }

  private async assertReferences(
    client: TenantQueryClient,
    data: {
      readonly customerPartyId: string;
      readonly shipperPartyId: string;
      readonly consigneePartyId: string;
      readonly originAddressId: string;
      readonly destinationAddressId: string;
    },
  ): Promise<void> {
    await this.assertPartyRole(client, data.customerPartyId, 'customer', 'customerPartyId');
    await this.assertPartyRole(client, data.shipperPartyId, 'shipper', 'shipperPartyId');
    await this.assertPartyRole(client, data.consigneePartyId, 'consignee', 'consigneePartyId');
    await this.assertActiveAddress(
      client,
      data.originAddressId,
      data.shipperPartyId,
      'originAddressId',
    );
    await this.assertActiveAddress(
      client,
      data.destinationAddressId,
      data.consigneePartyId,
      'destinationAddressId',
    );
  }

  private async assertPartyRole(
    client: TenantQueryClient,
    partyId: string,
    role: 'customer' | 'shipper' | 'consignee',
    field: string,
  ): Promise<void> {
    const result = await client.query<PartyReferenceRow>(
      `SELECT
         p.status::text AS status,
         EXISTS (
           SELECT 1
             FROM business_party_roles r
            WHERE r.tenant_id = p.tenant_id
              AND r.party_id = p.id
              AND r.role = $2
         ) AS has_role
       FROM business_parties p
       WHERE p.id = $1::uuid`,
      [partyId, role],
    );
    const row = result.rows[0];
    if (!row || row.status !== 'active' || !row.has_role) {
      throw new BadRequestException(
        `${field} must reference an active ${role} business party in the current tenant`,
      );
    }
  }

  private async assertActiveAddress(
    client: TenantQueryClient,
    addressId: string,
    partyId: string,
    field: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1
         FROM business_party_addresses
        WHERE id = $1::uuid
          AND party_id = $2::uuid
          AND is_active
        LIMIT 1`,
      [addressId, partyId],
    );
    if (result.rowCount !== 1) {
      throw new BadRequestException(
        `${field} must reference an active address owned by the expected business party in the current tenant`,
      );
    }
  }
}

function mapTransportRequest(row: TransportRequestRow): TransportRequest {
  return {
    id: row.id,
    customerPartyId: row.customer_party_id,
    shipperPartyId: row.shipper_party_id,
    consigneePartyId: row.consignee_party_id,
    originAddressId: row.origin_address_id,
    destinationAddressId: row.destination_address_id,
    plannedPickupAt: row.planned_pickup_at.toISOString(),
    plannedDeliveryAt: row.planned_delivery_at.toISOString(),
    cargoDescription: row.cargo_description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
