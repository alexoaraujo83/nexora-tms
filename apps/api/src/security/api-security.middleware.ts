import type { IncomingMessage, ServerResponse } from 'node:http';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const ALLOWED_BODY_CONTENT_TYPES = new Set([
  'application/json',
  'application/octet-stream',
  'multipart/form-data',
]);

export type ApiSecurityRequest = IncomingMessage & {
  originalUrl?: string;
};

type RateWindow = {
  count: number;
  resetAt: number;
};

export type ApiSecurityConfig = {
  windowMs: number;
  globalMaxRequests: number;
  sensitiveMaxRequests: number;
  maxTrackedClients: number;
  maxBodyBytes: number;
  trustForwardedFor: boolean;
};

type ApiSecurityOptions = {
  config?: Partial<ApiSecurityConfig>;
  now?: () => number;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function configFromEnvironment(): ApiSecurityConfig {
  return {
    windowMs: boundedInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000),
    globalMaxRequests: boundedInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 120, 1, 100_000),
    sensitiveMaxRequests: boundedInteger(
      process.env.RATE_LIMIT_SENSITIVE_MAX_REQUESTS,
      30,
      1,
      100_000,
    ),
    maxTrackedClients: boundedInteger(
      process.env.RATE_LIMIT_MAX_TRACKED_CLIENTS,
      10_000,
      100,
      100_000,
    ),
    maxBodyBytes: boundedInteger(process.env.MAX_REQUEST_BODY_BYTES, 1_048_576, 1_024, 10_485_760),
    trustForwardedFor: process.env.RATE_LIMIT_TRUST_FORWARDED_FOR === 'true',
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolvePath(request: ApiSecurityRequest): string {
  const raw = request.originalUrl ?? request.url ?? '/';
  try {
    return new URL(raw, 'http://nexora.internal').pathname;
  } catch {
    return '/';
  }
}

function resolveClientKey(request: ApiSecurityRequest, trustForwardedFor: boolean): string {
  if (trustForwardedFor) {
    const forwarded = firstHeaderValue(request.headers['x-forwarded-for'])?.split(',')[0]?.trim();
    if (forwarded && forwarded.length <= 128) {
      return `forwarded:${forwarded}`;
    }
  }

  return `socket:${request.socket?.remoteAddress ?? 'unknown'}`;
}

function isSensitivePath(path: string): boolean {
  return path.startsWith('/api/v1/auth/') || path === '/api/v1/tenant/runtime-gate';
}

function hasRequestBody(request: ApiSecurityRequest): boolean {
  const method = request.method?.toUpperCase() ?? 'GET';
  if (!BODY_METHODS.has(method)) {
    return false;
  }

  if (request.headers['transfer-encoding'] !== undefined) {
    return true;
  }

  const contentLength = firstHeaderValue(request.headers['content-length']);
  return contentLength !== undefined && contentLength !== '0';
}

function parseMediaType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType && /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mediaType)
    ? mediaType
    : undefined;
}

function acceptedContentType(request: ApiSecurityRequest): boolean {
  if (!hasRequestBody(request)) {
    return true;
  }

  const contentType = parseMediaType(firstHeaderValue(request.headers['content-type']));
  return contentType !== undefined && ALLOWED_BODY_CONTENT_TYPES.has(contentType);
}

function declaredBodySize(request: ApiSecurityRequest): number | undefined {
  const raw = firstHeaderValue(request.headers['content-length']);
  if (raw === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(raw)) {
    return Number.NaN;
  }

  return Number(raw);
}

function reject(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(JSON.stringify({ error: { code, message } }));
}

export function createApiSecurityMiddleware(options: ApiSecurityOptions = {}) {
  const defaults = configFromEnvironment();
  const config: ApiSecurityConfig = { ...defaults, ...options.config };
  const now = options.now ?? Date.now;
  const windows = new Map<string, RateWindow>();
  let requestsSincePrune = 0;

  function pruneExpired(currentTime: number): void {
    for (const [key, window] of windows) {
      if (window.resetAt <= currentTime) {
        windows.delete(key);
      }
    }
  }

  return function apiSecurityMiddleware(
    request: ApiSecurityRequest,
    response: ServerResponse,
    next: () => void,
  ): void {
    const method = request.method?.toUpperCase() ?? 'GET';
    if (method === 'TRACE') {
      reject(response, 405, 'METHOD_NOT_ALLOWED', 'HTTP TRACE is not allowed.');
      return;
    }

    const bodySize = declaredBodySize(request);
    if (Number.isNaN(bodySize)) {
      reject(response, 400, 'INVALID_CONTENT_LENGTH', 'Invalid Content-Length header.');
      return;
    }
    if (bodySize !== undefined && bodySize > config.maxBodyBytes) {
      reject(response, 413, 'PAYLOAD_TOO_LARGE', 'Request payload exceeds the configured limit.');
      return;
    }
    if (!acceptedContentType(request)) {
      reject(
        response,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'A supported Content-Type is required for requests with a body.',
      );
      return;
    }

    const currentTime = now();
    requestsSincePrune += 1;
    if (requestsSincePrune >= 100 || windows.size >= config.maxTrackedClients) {
      pruneExpired(currentTime);
      requestsSincePrune = 0;
    }

    const path = resolvePath(request);
    const sensitive = isSensitivePath(path);
    const limit = sensitive ? config.sensitiveMaxRequests : config.globalMaxRequests;
    const clientKey = resolveClientKey(request, config.trustForwardedFor);
    const bucketKey = `${clientKey}:${sensitive ? 'sensitive' : 'global'}`;
    let window = windows.get(bucketKey);

    if (!window || window.resetAt <= currentTime) {
      if (windows.size >= config.maxTrackedClients) {
        reject(
          response,
          503,
          'RATE_LIMIT_CAPACITY',
          'Request capacity is temporarily unavailable.',
        );
        return;
      }
      window = { count: 0, resetAt: currentTime + config.windowMs };
      windows.set(bucketKey, window);
    }

    window.count += 1;
    const remaining = Math.max(0, limit - window.count);
    const resetSeconds = Math.max(1, Math.ceil((window.resetAt - currentTime) / 1_000));
    response.setHeader('x-ratelimit-limit', String(limit));
    response.setHeader('x-ratelimit-remaining', String(remaining));
    response.setHeader('x-ratelimit-reset', String(Math.ceil(window.resetAt / 1_000)));

    if (window.count > limit) {
      reject(response, 429, 'RATE_LIMITED', 'Too many requests.', {
        'retry-after': String(resetSeconds),
      });
      return;
    }

    next();
  };
}

export const apiSecurityMiddleware = createApiSecurityMiddleware();
