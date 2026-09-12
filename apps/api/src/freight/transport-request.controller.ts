import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { TenantAuthorized } from '../security/tenant-authorized.decorator.js';
import {
  parseTransportRequestListQuery,
  type TransportRequestListQuery,
} from './transport-request-list.validation.js';
import { TransportRequestService, type TransportRequest } from './transport-request.service.js';

@Controller('api/v1/freight/transport-requests')
export class TransportRequestController {
  constructor(private readonly transportRequests: TransportRequestService) {}

  @Get()
  @TenantAuthorized('freight.read')
  list(@Query() query: Record<string, unknown>): Promise<readonly TransportRequest[]> {
    const pagination: TransportRequestListQuery = parseTransportRequestListQuery(query);
    return this.transportRequests.list(pagination);
  }

  @Post()
  @TenantAuthorized('freight.write')
  create(@Body() body: unknown): Promise<TransportRequest> {
    return this.transportRequests.create(body);
  }

  @Get(':id')
  @TenantAuthorized('freight.read')
  getById(@Param('id') id: string): Promise<TransportRequest> {
    return this.transportRequests.getById(id);
  }

  @Patch(':id')
  @TenantAuthorized('freight.write')
  update(@Param('id') id: string, @Body() body: unknown): Promise<TransportRequest> {
    return this.transportRequests.update(id, body);
  }
}
