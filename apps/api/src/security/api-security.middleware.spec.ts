import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import { createApiSecurityMiddleware, type ApiSecurityRequest } from './api-security.middleware.js';

class FakeResponse extends EventEmitter {
  statusCode = 200;
  body = '';
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value));
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    this.emit('finish');
    return this;
  }
}

function request(
  input: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
): ApiSecurityRequest {
  return {
    headers: input.headers ?? {},
    method: input.method ?? 'GET',
    url: input.url ?? '/api/v1/example',
    socket: { remoteAddress: input.remoteAddress ?? '203.0.113.10' },
  } as unknown as IncomingMessage & ApiSecurityRequest;
}

function response(): FakeResponse {
  return new FakeResponse();
}

test('rate limiter allows requests up to the configured global limit and then returns 429', () => {
  let clock = 1_000;
  const middleware = createApiSecurityMiddleware({
    now: () => clock,
    config: {
      windowMs: 60_000,
      globalMaxRequests: 2,
      sensitiveMaxRequests: 1,
      maxTrackedClients: 100,
      maxBodyBytes: 1_024,
      trustForwardedFor: false,
    },
  });

  for (let index = 0; index < 2; index += 1) {
    const res = response();
    let nextCalled = false;
    middleware(request(), res as unknown as ServerResponse, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  }

  const limited = response();
  middleware(request(), limited as unknown as ServerResponse, () =>
    assert.fail('must not continue'),
  );
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.match(limited.body, /RATE_LIMITED/);

  clock += 60_001;
  const afterReset = response();
  let resetNext = false;
  middleware(request(), afterReset as unknown as ServerResponse, () => {
    resetNext = true;
  });
  assert.equal(resetNext, true);
});

test('sensitive authentication paths use the stricter limit', () => {
  const middleware = createApiSecurityMiddleware({
    now: () => 5_000,
    config: {
      windowMs: 60_000,
      globalMaxRequests: 10,
      sensitiveMaxRequests: 1,
      maxTrackedClients: 100,
      maxBodyBytes: 1_024,
      trustForwardedFor: false,
    },
  });

  middleware(
    request({ url: '/api/v1/auth/me' }),
    response() as unknown as ServerResponse,
    () => undefined,
  );

  const limited = response();
  middleware(request({ url: '/api/v1/auth/me' }), limited as unknown as ServerResponse, () =>
    assert.fail('must not continue'),
  );
  assert.equal(limited.statusCode, 429);
});

test('request bodies require a supported content type', () => {
  const middleware = createApiSecurityMiddleware({
    config: {
      windowMs: 60_000,
      globalMaxRequests: 10,
      sensitiveMaxRequests: 5,
      maxTrackedClients: 100,
      maxBodyBytes: 1_024,
      trustForwardedFor: false,
    },
  });
  const res = response();

  middleware(
    request({ method: 'POST', headers: { 'content-length': '10' } }),
    res as unknown as ServerResponse,
    () => assert.fail('must not continue'),
  );

  assert.equal(res.statusCode, 415);
  assert.match(res.body, /UNSUPPORTED_MEDIA_TYPE/);
});

test('content type validation compares the parsed media type exactly', () => {
  const middleware = createApiSecurityMiddleware({
    config: {
      windowMs: 60_000,
      globalMaxRequests: 10,
      sensitiveMaxRequests: 5,
      maxTrackedClients: 100,
      maxBodyBytes: 1_024,
      trustForwardedFor: false,
    },
  });

  const validJson = response();
  middleware(
    request({
      method: 'POST',
      headers: { 'content-length': '10', 'content-type': 'Application/JSON; charset=utf-8' },
    }),
    validJson as unknown as ServerResponse,
    () => undefined,
  );
  assert.equal(validJson.statusCode, 200);

  const spoofed = response();
  middleware(
    request({
      method: 'POST',
      headers: { 'content-length': '10', 'content-type': 'application/json-malicious' },
    }),
    spoofed as unknown as ServerResponse,
    () => assert.fail('must not continue'),
  );
  assert.equal(spoofed.statusCode, 415);
});

test('multipart media types are accepted only when the base type is valid', () => {
  const middleware = createApiSecurityMiddleware({
    config: {
      windowMs: 60_000,
      globalMaxRequests: 10,
      sensitiveMaxRequests: 5,
      maxTrackedClients: 100,
      maxBodyBytes: 1_024,
      trustForwardedFor: false,
    },
  });

  const validMultipart = response();
  middleware(
    request({
      method: 'POST',
      headers: {
        'content-length': '10',
        'content-type': 'multipart/form-data; boundary=----nexora',
      },
    }),
    validMultipart as unknown as ServerResponse,
    () => undefined,
  );
  assert.equal(validMultipart.statusCode, 200);

  const invalidMultipart = response();
  middleware(
    request({
      method: 'POST',
      headers: { 'content-length': '10', 'content-type': 'multipart/form-data-malicious' },
    }),
    invalidMultipart as unknown as ServerResponse,
    () => assert.fail('must not continue'),
  );
  assert.equal(invalidMultipart.statusCode, 415);
});

test('oversized request payloads fail closed before controller execution', () => {
  const middleware = createApiSecurityMiddleware({
    config: {
      windowMs: 60_000,
      globalMaxRequests: 10,
      sensitiveMaxRequests: 5,
      maxTrackedClients: 100,
      maxBodyBytes: 100,
      trustForwardedFor: false,
    },
  });
  const res = response();

  middleware(
    request({
      method: 'POST',
      headers: { 'content-length': '101', 'content-type': 'application/json' },
    }),
    res as unknown as ServerResponse,
    () => assert.fail('must not continue'),
  );

  assert.equal(res.statusCode, 413);
  assert.match(res.body, /PAYLOAD_TOO_LARGE/);
});

test('TRACE is rejected globally', () => {
  const middleware = createApiSecurityMiddleware();
  const res = response();

  middleware(request({ method: 'TRACE' }), res as unknown as ServerResponse, () =>
    assert.fail('must not continue'),
  );

  assert.equal(res.statusCode, 405);
  assert.match(res.body, /METHOD_NOT_ALLOWED/);
});

test('forwarded client identity is ignored unless explicitly trusted', () => {
  const config = {
    windowMs: 60_000,
    globalMaxRequests: 1,
    sensitiveMaxRequests: 1,
    maxTrackedClients: 100,
    maxBodyBytes: 1_024,
    trustForwardedFor: false,
  };
  const middleware = createApiSecurityMiddleware({ now: () => 10_000, config });

  middleware(
    request({ headers: { 'x-forwarded-for': '198.51.100.1' } }),
    response() as unknown as ServerResponse,
    () => undefined,
  );

  const limited = response();
  middleware(
    request({ headers: { 'x-forwarded-for': '198.51.100.2' } }),
    limited as unknown as ServerResponse,
    () => assert.fail('must not continue'),
  );
  assert.equal(limited.statusCode, 429);
});
