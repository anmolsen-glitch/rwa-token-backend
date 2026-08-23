/**
 * Bootstrap.
 *
 * The strangler hinge lives here: routes this app implements are served by
 * Nest; everything else is proxied to the Express backend at LEGACY_API_URL.
 * That means day one is not a cutover — the two apps serve one API surface
 * together, and the proxy shrinks as modules land.
 *
 * A route is "migrated" only when its Express handler is DELETED. Two live
 * implementations of one route is the failure mode this plan exists to avoid.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import proxy from '@fastify/http-proxy';
import multipart from '@fastify/multipart';

import { AppModule } from './app.module';
import { AppConfig } from '@shared/config/app-config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));
  const config = app.get(AppConfig);
  const isProd = config.isProduction;

  /*
   * Treat an empty JSON body as {}.
   *
   * Fastify rejects `content-type: application/json` with a zero-length body
   * (FST_ERR_CTP_EMPTY_JSON_BODY, 400). Plenty of HTTP clients — axios and most
   * fetch wrappers — set that header on every POST regardless of whether they
   * are sending anything, so bodyless actions like "close this proposal" or
   * "attach this manager" would 400 for reasons that have nothing to do with
   * the request. Anything non-empty still parses (and still fails loudly if it
   * is malformed), so this widens tolerance without weakening validation: the
   * Zod pipe is what decides whether {} is acceptable for a given route.
   */
  /*
   * Tolerate an empty JSON body.
   *
   * Fastify rejects `content-type: application/json` with a zero-length body
   * (FST_ERR_CTP_EMPTY_JSON_BODY, 400), and axios and most fetch wrappers set
   * that header on every POST regardless of whether they send anything — so
   * bodyless actions like "close this proposal" or "attach this manager" would
   * 400 for reasons unrelated to the request.
   *
   * Done as an onRequest HOOK rather than a replacement body parser: registering
   * a parser for `application/json` collides with @fastify/http-proxy, which
   * registers its own to stream bodies through to the legacy app
   * (FST_ERR_CTP_ALREADY_PRESENT at boot). Stripping the header instead leaves
   * both parsers untouched, and Fastify then simply sees a request with no body.
   */
  app.getHttpAdapter().getInstance().addHook('onRequest', (req, _reply, done) => {
    const type = req.headers['content-type'];
    const length = req.headers['content-length'];
    /* Empty means either an explicit zero length or no body framing at all —
       clients differ (node's fetch sends `content-length: 0`, curl may send
       neither), and both mean the same thing here. */
    const empty = length === '0' || (length === undefined && !req.headers['transfer-encoding']);
    if (type?.startsWith('application/json') && empty) {
      delete req.headers['content-type'];
    }
    done();
  });

  await app.register(helmet, { contentSecurityPolicy: isProd });
  await app.register(cors, {
    origin: config.get('CORS_ORIGINS'),
    credentials: true, // required: sessions are cookie-based
  });
  await app.register(cookie);
  /* KYC document uploads. The per-file cap is enforced here AND re-checked in
     the service — this limit protects the process, that one protects the quota. */
  await app.register(multipart, {
    limits: { fileSize: config.get('DOCUMENT_MAX_BYTES'), files: 1 },
  });
  await app.register(rateLimit, {
    max: config.get('RATE_LIMIT_MAX'),
    timeWindow: config.get('RATE_LIMIT_WINDOW_MS'),
  });

  /*
   * Capture the RAW body for webhook signature verification. Fastify parses
   * JSON before the handler runs, and re-serialising it can reorder keys or
   * change spacing — which breaks every provider HMAC. The signature must be
   * checked against the bytes actually received.
   */
  app.getHttpAdapter().getInstance().addHook('preParsing', (req, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    payload.on('data', (c: Buffer) => chunks.push(c));
    payload.on('end', () => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    });
    done(null, payload);
  });

  app.setGlobalPrefix('api');

  if (!isProd) {
    const doc = new DocumentBuilder()
      .setTitle('RWA Token Backend (Nest)')
      .setDescription(
        [
          'ERC-3643 real-world-asset tokenization platform.',
          '',
          '### Authentication',
          'Session JWT in an **httpOnly cookie** (`rwa_admin_token`) for browsers, or',
          '`Authorization: Bearer <token>` for API clients. Cookie-authenticated',
          '**mutations must also send `x-csrf-token`** matching the `rwa_csrf` cookie;',
          'Bearer requests are exempt because they carry no ambient credential.',
          '',
          '### Route layout',
          'Paths are prefixed by AUDIENCE, so the intended caller is visible without',
          'reading the auth decorators:',
          '',
          '- `/api/admin/*` — back-office: platform operators and issuer staff (`admin` session)',
          '- `/api/investor/*` — investor self-service (`account` session)',
          '- everything else — public, no session (`/api/health`, `/api/offerings/public`)',
          '',
          'Note there are two logins, and they are NOT interchangeable:',
          '`/api/admin/auth/login` authenticates against `admins`;',
          '`/api/investor/login` authenticates against `accounts`. Different credential',
          'stores, different cookies, different `typ` claim.',
          '',
          '### Tenancy',
          'Every response is scoped to the caller\'s tenant, derived from the verified',
          'token and never from a request parameter. An `issuer_admin` sees only its own',
          'issuer; an investor sees only their own records; `platform_admin` crosses',
          'tenants and every such action is audited. Requesting another tenant\'s',
          'resource returns **404, not 403** — confirming existence would itself be a leak.',
          '',
          '### Errors',
          'Every error uses one envelope: `{ "error": { "code", "message", "details? } }`.',
          '`code` is stable and safe to branch on; `message` is for humans and may change.',
        ].join('\n'),
      )
      .setVersion('0.1.0')
      /* Both accepted everywhere — see the Authentication note above. */
      .addCookieAuth('rwa_admin_token', { type: 'apiKey', in: 'cookie' }, 'session')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
      .addTag('Health', 'Liveness, chain reachability, and claim-issuer posture')
      .addTag('Admin Auth', 'Back-office login/logout and the session\'s resolved tenant')
      .addTag('Issuers', 'SPVs. Platform sees all; an issuer sees only itself')
      .addTag('Offerings', 'Tokenized assets. /api/admin/offerings is issuer-scoped; /api/offerings/public is world-readable')
      .addTag('Cap Table', 'Investors on YOUR issuer\'s cap table. PII reads are audited')
      .addTag('Onboarding', 'Non-custodial ONCHAINID + claim issuance')
      .addTag('KYC', 'Platform-level verification. Issuers record acceptance instead')
      .addTag('KYC Documents', 'Identity documents. Encrypted at rest; reviewer reads are audited')
      .addTag('AML', 'Sanctions / risk screening. Person status is the WORST across their wallets')
      .addTag('Accreditation', 'Accredited-investor status. Grant is off-chain, revoke is on-chain')
      .addTag('Investor', 'Investor self-service: sign up, verify, KYC, connect wallet')
      .build();

    SwaggerModule.setup('docs', app, cleanupOpenApiDoc(SwaggerModule.createDocument(app, doc)), {
      swaggerOptions: { persistAuthorization: true, docExpansion: 'list' },
    });
  }

  /* Strangler fallback — must be registered LAST so Nest's own routes win. */
  const legacy = config.get('LEGACY_API_URL');
  if (legacy) {
    await app.register(proxy, {
      upstream: legacy,
      prefix: '/api',
      rewritePrefix: '/api',
      http2: false,
      replyOptions: {
        rewriteRequestHeaders: (_req, headers) => headers, // keep cookies intact
      },
    });
    app.get(Logger).log(`Unmigrated /api routes proxy to ${legacy}`);
  }

  const port = config.get('PORT');
  await app.listen({ port, host: '0.0.0.0' });
  app.get(Logger).log(`Nest backend listening on :${port}`);
}

void bootstrap();
