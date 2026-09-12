import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { httpObservabilityMiddleware } from './observability/http-observability.middleware.js';
import { apiSecurityMiddleware } from './security/api-security.middleware.js';

function requestBodyLimit(): string {
  const configured = Number(process.env.MAX_REQUEST_BODY_BYTES ?? 1_048_576);
  return Number.isSafeInteger(configured) && configured >= 1_024 && configured <= 10_485_760
    ? `${configured}b`
    : '1mb';
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const bodyLimit = requestBodyLimit();

  // Enforce the same bounded request size at the Express parser layer. This also
  // protects chunked JSON/urlencoded requests where Content-Length is absent.
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  app.use(httpObservabilityMiddleware);
  app.use(apiSecurityMiddleware);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
