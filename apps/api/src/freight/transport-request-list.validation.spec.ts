import assert from 'node:assert/strict';
import test from 'node:test';

import { BadRequestException } from '@nestjs/common';

import { parseTransportRequestListQuery } from './transport-request-list.validation.js';

test('uses safe defaults when no list query is supplied', () => {
  assert.deepEqual(parseTransportRequestListQuery(undefined), { limit: 50, offset: 0 });
});

test('accepts bounded pagination values', () => {
  assert.deepEqual(parseTransportRequestListQuery({ limit: '25', offset: '50' }), {
    limit: 25,
    offset: 50,
  });
});

test('rejects an unbounded page size', () => {
  assert.throws(
    () => parseTransportRequestListQuery({ limit: '101' }),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test('rejects malformed pagination values', () => {
  assert.throws(
    () => parseTransportRequestListQuery({ offset: '-1' }),
    (error: unknown) => error instanceof BadRequestException,
  );
});
