import { BadRequestException } from '@nestjs/common';

export interface TransportRequestListQuery {
  readonly limit: number;
  readonly offset: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException(`${field} is outside the supported range`);
  }
  return parsed;
}

export function parseTransportRequestListQuery(input: unknown): TransportRequestListQuery {
  if (input === undefined || input === null) {
    return { limit: DEFAULT_LIMIT, offset: 0 };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Query parameters must be an object');
  }

  const query = input as Record<string, unknown>;
  const limit =
    query.limit === undefined ? DEFAULT_LIMIT : parseNonNegativeInteger(query.limit, 'limit');
  const offset =
    query.offset === undefined ? 0 : parseNonNegativeInteger(query.offset, 'offset');

  if (limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
  }

  return { limit, offset };
}
