import { BadRequestException } from '@nestjs/common';

export type CarrierPaymentTransactionKind = 'advance' | 'payment' | 'reversal';

export interface CreateCarrierPaymentObligationInput {
  readonly transportContractId: string;
  readonly tripId: string | null;
  readonly dueAt: string;
  readonly notes: string | null;
}

export interface UpdateCarrierPaymentObligationInput {
  readonly dueAt?: string;
  readonly tripId?: string | null;
  readonly notes?: string | null;
}

export interface CreateCarrierPaymentTransactionInput {
  readonly kind: CarrierPaymentTransactionKind;
  readonly amount: string;
  readonly relatedTransactionId: string | null;
  readonly proofDocumentId: string | null;
  readonly occurredAt: string;
  readonly notes: string | null;
}

export function requireFinanceUuid(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be a UUID`);
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new BadRequestException(`${field} must be a valid UUID`);
  }
  return normalized;
}

export function parseCreateCarrierPaymentObligation(
  input: unknown,
): CreateCarrierPaymentObligationInput {
  const body = requireObject(input);
  return {
    transportContractId: requireFinanceUuid(body.transportContractId, 'transportContractId'),
    tripId: optionalUuid(body.tripId, 'tripId'),
    dueAt: requireDateTime(body.dueAt, 'dueAt'),
    notes: optionalText(body.notes, 'notes', 1000),
  };
}

export function parseUpdateCarrierPaymentObligation(
  input: unknown,
): UpdateCarrierPaymentObligationInput {
  const body = requireObject(input);
  const parsed: {
    dueAt?: string;
    tripId?: string | null;
    notes?: string | null;
  } = {};

  if ('dueAt' in body) parsed.dueAt = requireDateTime(body.dueAt, 'dueAt');
  if ('tripId' in body) parsed.tripId = optionalUuid(body.tripId, 'tripId');
  if ('notes' in body) parsed.notes = optionalText(body.notes, 'notes', 1000);

  if (Object.keys(parsed).length === 0) {
    throw new BadRequestException('at least one obligation field must be supplied');
  }
  return parsed;
}

export function parseCancelCarrierPaymentObligation(input: unknown): { readonly reason: string } {
  const body = requireObject(input);
  const reason = requireText(body.reason, 'reason', 10, 1000);
  return { reason };
}

export function parseCreateCarrierPaymentTransaction(
  input: unknown,
): CreateCarrierPaymentTransactionInput {
  const body = requireObject(input);
  const kind = requireTransactionKind(body.kind);
  const relatedTransactionId = optionalUuid(body.relatedTransactionId, 'relatedTransactionId');

  if (kind === 'reversal' && !relatedTransactionId) {
    throw new BadRequestException('relatedTransactionId is required for reversal');
  }
  if (kind !== 'reversal' && relatedTransactionId) {
    throw new BadRequestException('relatedTransactionId is only valid for reversal');
  }

  return {
    kind,
    amount: requireMoney(body.amount, 'amount'),
    relatedTransactionId,
    proofDocumentId: optionalUuid(body.proofDocumentId, 'proofDocumentId'),
    occurredAt:
      body.occurredAt === undefined
        ? new Date().toISOString()
        : requireDateTime(body.occurredAt, 'occurredAt'),
    notes: optionalText(body.notes, 'notes', 1000),
  };
}

function requireObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('request body must be an object');
  }
  return input as Record<string, unknown>;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireFinanceUuid(value, field);
}

function requireDateTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} must be an ISO date-time`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new BadRequestException(`${field} must be a valid date-time`);
  return date.toISOString();
}

function requireTransactionKind(value: unknown): CarrierPaymentTransactionKind {
  if (value === 'advance' || value === 'payment' || value === 'reversal') return value;
  throw new BadRequestException('kind must be advance, payment or reversal');
}

function requireMoney(value: unknown, field: string): string {
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';

  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) {
    throw new BadRequestException(
      `${field} must be a positive monetary value with up to 2 decimals`,
    );
  }

  const [integerPart, decimalPart = ''] = text.split('.');
  if (/^0+$/.test(integerPart) && /^0*$/.test(decimalPart)) {
    throw new BadRequestException(`${field} must be greater than zero`);
  }

  // Keep money as a decimal string. Do not round through IEEE-754 Number arithmetic.
  return `${integerPart}.${decimalPart.padEnd(2, '0')}`;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max)
    throw new BadRequestException(`${field} must have at most ${max} characters`);
  return normalized;
}

function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new BadRequestException(`${field} must have between ${min} and ${max} characters`);
  }
  return normalized;
}
