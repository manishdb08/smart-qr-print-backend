import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import crypto from 'node:crypto';

import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { checkDatabaseConnection } from './db/client.js';
import { qrSessionRoutes } from './modules/qr-sessions/qrSession.routes.js';
import { printerRoutes } from './modules/printers/printer.routes.js';
import { uploadRoutes } from './modules/uploads/upload.routes.js';
import { assetRoutes } from './modules/assets/asset.routes.js';
import { transformationRoutes } from './modules/transformations/transformation.routes.js';
import { printJobRoutes } from './modules/print-jobs/printJob.routes.js';
import { paymentRoutes } from './modules/payments/payment.routes.js';
import { agentRoutes } from './modules/agent/agent.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: config.NODE_ENV === 'test'
      ? false
      : {
          level: 'info',
          formatters: {
            level: (label) => ({ level: label }),
          },
          serializers: {
            req: (req) => ({
              method: req.method,
              url: req.url,
              id: req.id,
              ip: req.ip,
            }),
          },
        },
    genReqId: (req) => {
      const headerId = req.headers['x-request-id'];
      if (typeof headerId === 'string' && headerId.length > 0) {
        return headerId;
      }
      return crypto.randomUUID();
    },
  });

  // Set X-Request-Id header on all outgoing responses
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // 1. Security Headers (Helmet)
  await app.register(helmet, {
    contentSecurityPolicy: config.NODE_ENV === 'production',
  });

  // 2. CORS Restriction
  const allowedOrigins = config.CORS_ORIGIN === '*'
    ? true
    : config.CORS_ORIGIN.split(',').map((o) => o.trim());

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-Secret', 'X-Printer-Id', 'X-Request-Id', 'Idempotency-Key'],
  });

  // 3. Global Rate Limiter
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: ['/health', '/ready', '/docs', '/docs/json'],
  });

  // 4. OpenAPI / Swagger Documentation
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Smart QR Print Backend API',
        description: 'Production-oriented, zero-trust backend for QR-based self-service printing kiosk network.',
        version: '1.0.0',
      },
      servers: [
        {
          url: `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`,
          description: 'Server environment',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Supabase JWT or test token for authenticated customer, operator, or admin.',
          },
          agentSecretAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'x-agent-secret',
            description: 'Shared secret authentication for local printer agent hardware daemon.',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: false,
    },
    staticCSP: true,
  });


  // 5. Centralized Error Handler
  app.setErrorHandler(errorHandler);

  // 6. Root & Health Probes
  app.get('/', async () => ({
    name: 'Smart QR Print Backend API',
    status: 'online',
    version: '1.0.0',
    documentation: '/docs',
    timestamp: new Date().toISOString(),
  }));

  app.get('/health', async () => ({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    const dbStatus = await checkDatabaseConnection();
    if (!dbStatus.healthy) {
      return reply.status(503).send({
        status: 'unready',
        database: dbStatus,
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      status: 'ready',
      database: dbStatus,
      timestamp: new Date().toISOString(),
    });
  });

  // Preserve raw body for accurate HMAC webhook verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try {
      (req as any).rawBody = body.toString('utf-8');
      const json = JSON.parse(body.toString('utf-8'));
      done(null, json);
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // 7. Register V1 API Routes
  await app.register(
    async (v1) => {
      await v1.register(qrSessionRoutes);
      await v1.register(printerRoutes);
      await v1.register(uploadRoutes);
      await v1.register(assetRoutes);
      await v1.register(transformationRoutes);
      await v1.register(printJobRoutes);
      await v1.register(paymentRoutes);
      await v1.register(agentRoutes);
    },
    { prefix: config.API_PREFIX }
  );

  return app;
}
