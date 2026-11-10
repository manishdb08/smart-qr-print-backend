process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://smartqr:smartqr_secret@localhost:5432/smart_qr_print?schema=public';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';
import { PRICING_RULES, config } from '../src/config/index.js';
import { verifyQrSignature } from '../src/modules/qr-sessions/qrSession.service.js';
import { requireRole } from '../src/auth/rbac.js';
import { requirePrintAgentAuth } from '../src/auth/agentAuth.js';

describe('Milestone 1: Database & Auth Foundation Integration Tests', () => {
  let app: FastifyInstance;

  // In-memory test store matching seeded printers and capabilities
  const testPrinters: Record<string, any> = {
    'library-a4-01': {
      id: 'library-a4-01',
      name: 'Central Library Color Multi-Function Printer',
      location: 'Main Library 1st Floor - Kiosk Area',
      status: 'online',
      lastHeartbeatAt: new Date(),
      capabilities: {
        id: 'cap-1',
        printerId: 'library-a4-01',
        supportsColor: true,
        supportsMono: true,
        supportsDuplex: true,
        supportedPageSizes: ['A4'],
        maxDpi: 1200,
      },
    },
    'lab-mono-01': {
      id: 'lab-mono-01',
      name: 'Computer Science Lab Mono High-Speed Printer',
      location: 'CS Building Room 204',
      status: 'online',
      lastHeartbeatAt: new Date(),
      capabilities: {
        id: 'cap-2',
        printerId: 'lab-mono-01',
        supportsColor: false,
        supportsMono: true,
        supportsDuplex: true,
        supportedPageSizes: ['A4'],
        maxDpi: 600,
      },
    },
  };

  const testSessions: Record<string, any> = {};

  beforeAll(async () => {
    // Setup Prisma mocks for deterministic in-memory integration testing
    vi.spyOn(prisma.printer, 'findMany').mockImplementation(async () => {
      return Object.values(testPrinters);
    });

    vi.spyOn(prisma.printer, 'findUnique').mockImplementation(async (args: any) => {
      const printer = testPrinters[args.where.id];
      if (!printer) return null;
      return printer;
    });

    vi.spyOn(prisma.printerCapability, 'findUnique').mockImplementation(async (args: any) => {
      const printer = testPrinters[args.where.printerId];
      return printer?.capabilities ?? null;
    });

    vi.spyOn(prisma.qrSession, 'create').mockImplementation(async (args: any) => {
      const created = {
        id: args.data.id || 'mock-session-id',
        ...args.data,
        createdAt: new Date(),
      };
      testSessions[created.id] = created;
      return created;
    });

    vi.spyOn(prisma.user, 'findFirst').mockImplementation(async (args: any) => {
      const email = args?.where?.email;
      if (!email) return null;
      const role = email.split('@')[0];
      return {
        id: `mock-user-${role}`,
        email,
        role,
        name: `Mock ${role}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;
    });

    vi.spyOn(prisma.printerAgent, 'findFirst').mockImplementation(async () => {
      return null;
    });

    vi.spyOn(prisma.auditEvent, 'create').mockImplementation(async (args: any) => {
      return {
        id: 'mock-audit-id',
        ...args.data,
        createdAt: new Date(),
      };
    });

    // Mock raw query check for /ready probe
    vi.spyOn(prisma, '$queryRaw').mockImplementation(async () => [{ 1: 1 }]);

    app = await buildApp();

    // Register test protected routes to thoroughly verify RBAC and agent auth
    app.get('/test/protected-admin', { preHandler: [requireRole(['admin'])] }, async (req) => ({
      message: 'Hello Admin',
      userId: req.user?.id,
    }));

    app.get('/test/protected-customer', { preHandler: [requireRole(['customer'])] }, async (req) => ({
      message: 'Hello Customer',
      userId: req.user?.id,
    }));

    app.get('/test/agent-only', { preHandler: [requirePrintAgentAuth] }, async (req) => ({
      message: 'Agent authenticated successfully',
      agent: req.agent,
    }));

    await app.ready();
  });

  // ---------------------------------------------------------------------------
  // 1. Health and Probes
  // ---------------------------------------------------------------------------
  describe('Health Probes & Swagger Docs', () => {
    it('GET /health returns healthy status with uptime', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('healthy');
      expect(typeof body.uptimeSeconds).toBe('number');
      expect(body.timestamp).toBeDefined();
    });

    it('GET /ready returns database readiness status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ready',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('ready');
      expect(body.database.healthy).toBe(true);
    });

    it('GET /docs/json returns valid OpenAPI 3.0 specification', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/docs/json',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.openapi).toBeDefined();
      expect(body.info.title).toContain('Smart QR Print');
      expect(body.paths['/v1/qr-sessions']).toBeDefined();
      expect(body.paths['/v1/printers/{printerId}']).toBeDefined();
    });

    it('GET /docs returns Swagger documentation entry', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/docs',
      });

      // Redirects to /docs/ or returns 200
      expect([200, 302]).toContain(res.statusCode);
    });

    it('Each response contains a valid X-Request-Id header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.headers['x-request-id']).toBeDefined();
      expect(typeof res.headers['x-request-id']).toBe('string');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Printers and Capabilities
  // ---------------------------------------------------------------------------
  describe('Printers & Hardware Capabilities', () => {
    it('GET /v1/printers returns all seeded printers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/printers',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(2);

      const printerIds = body.data.map((p: any) => p.id);
      expect(printerIds).toContain('library-a4-01');
      expect(printerIds).toContain('lab-mono-01');
    });

    it('GET /v1/printers/library-a4-01 returns color, mono, duplex, and A4 capability', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/printers/library-a4-01',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('library-a4-01');
      expect(body.data.capabilities.supportsColor).toBe(true);
      expect(body.data.capabilities.supportsMono).toBe(true);
      expect(body.data.capabilities.supportsDuplex).toBe(true);
      expect(body.data.capabilities.supportedPageSizes).toEqual(['A4']);
    });

    it('GET /v1/printers/lab-mono-01 returns mono only, duplex, and A4 capability', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/printers/lab-mono-01',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('lab-mono-01');
      expect(body.data.capabilities.supportsColor).toBe(false);
      expect(body.data.capabilities.supportsMono).toBe(true);
      expect(body.data.capabilities.supportsDuplex).toBe(true);
      expect(body.data.capabilities.supportedPageSizes).toEqual(['A4']);
    });

    it('GET /v1/printers/:printerId/capabilities retrieves capability details directly', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/printers/library-a4-01/capabilities',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.printerId).toBe('library-a4-01');
      expect(body.data.supportsColor).toBe(true);
      expect(body.data.maxDpi).toBe(1200);
    });

    it('GET /v1/printers/non-existent-printer returns 404 with structured error', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/printers/non-existent-printer',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain("Printer 'non-existent-printer' not found");
      expect(body.meta.requestId).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. QR Sessions
  // ---------------------------------------------------------------------------
  describe('QR Sessions & Cryptographic Signatures', () => {
    it('POST /v1/qr-sessions creates a signed, short-lived session for valid printer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/qr-sessions',
        payload: {
          printerId: 'library-a4-01',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.sessionId).toBeDefined();
      expect(body.data.printerId).toBe('library-a4-01');
      expect(body.data.token).toBeDefined();
      expect(body.data.signature).toBeDefined();
      expect(body.data.ttlSeconds).toBe(config.QR_SESSION_TTL_MINUTES * 60);

      // Verify the cryptographic HMAC signature
      const expiresAtMs = new Date(body.data.expiresAt).getTime();
      const isValidSig = verifyQrSignature(
        body.data.sessionId,
        body.data.printerId,
        expiresAtMs,
        body.data.signature
      );
      expect(isValidSig).toBe(true);

      // Verify tamper rejection
      const isTamperedSigValid = verifyQrSignature(
        body.data.sessionId,
        'tampered-printer-id',
        expiresAtMs,
        body.data.signature
      );
      expect(isTamperedSigValid).toBe(false);
    });

    it('POST /v1/qr-sessions rejects non-existent printer with 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/qr-sessions',
        payload: {
          printerId: 'unknown-printer-999',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain("Printer 'unknown-printer-999' not found");
    });

    it('POST /v1/qr-sessions rejects missing printerId with 400 schema error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/qr-sessions',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('SCHEMA_VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Role-Based Access Control (RBAC) & Agent Auth
  // ---------------------------------------------------------------------------
  describe('Authentication & Role-Based Access Control (RBAC)', () => {
    it('Rejects unauthenticated access to protected route with 401 UNAUTHORIZED', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected-customer',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('Allows customer to access customer-protected route', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected-customer',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.message).toBe('Hello Customer');
    });

    it('Denies customer access to admin-only route with 403 FORBIDDEN', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected-admin',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('FORBIDDEN');
    });

    it('Allows admin access to admin-only route', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected-admin',
        headers: {
          authorization: 'Bearer test-token-admin',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.message).toBe('Hello Admin');
    });

    it('Printer agent authentication rejects missing credentials with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/agent-only',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('AGENT_UNAUTHORIZED');
    });

    it('Printer agent authentication rejects invalid secret with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/agent-only',
        headers: {
          'x-agent-secret': 'wrong-unauthorized-secret-xyz',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('AGENT_INVALID_CREDENTIALS');
    });

    it('Printer agent authentication accepts valid shared secret via x-agent-secret', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/agent-only',
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'library-a4-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.message).toBe('Agent authenticated successfully');
      expect(body.agent.role).toBe('print_agent');
      expect(body.agent.printerId).toBe('library-a4-01');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Pricing Configuration Integrity
  // ---------------------------------------------------------------------------
  describe('Pricing Rules Integrity', () => {
    it('Enforces default integer paise pricing and duplex discount', () => {
      expect(PRICING_RULES.baseMonoPagePaise).toBe(200); // 200 paise = 2 INR
      expect(PRICING_RULES.baseColorPagePaise).toBe(800); // 800 paise = 8 INR
      expect(PRICING_RULES.duplexDiscountPercent).toBe(10); // 10%
      expect(PRICING_RULES.minOrderPaise).toBe(200); // 200 paise
      expect(PRICING_RULES.version).toBe('v1.0.0');
      expect(PRICING_RULES.currency).toBe('INR');

      // Check integer types
      expect(Number.isInteger(PRICING_RULES.baseMonoPagePaise)).toBe(true);
      expect(Number.isInteger(PRICING_RULES.baseColorPagePaise)).toBe(true);
      expect(Number.isInteger(PRICING_RULES.minOrderPaise)).toBe(true);
    });
  });
});
