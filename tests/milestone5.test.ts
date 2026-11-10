process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://smartqr:smartqr_secret@localhost:5432/smart_qr_print?schema=public';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';
import { config } from '../src/config/index.js';
import { detectOfflinePrinters } from '../src/modules/agent/agent.service.js';

describe('Milestone 5: Printer Agent & Dispatch Queue Integration Tests', () => {
  let app: FastifyInstance;

  // In-memory repositories
  const printersDb: Record<string, any> = {
    'library-a4-01': {
      id: 'library-a4-01',
      name: 'Central Library Color Printer',
      status: 'online',
      location: '1st Floor',
      lastHeartbeatAt: new Date(),
    },
    'lab-mono-01': {
      id: 'lab-mono-01',
      name: 'CS Lab Mono Printer',
      status: 'online',
      location: 'Room 204',
      lastHeartbeatAt: new Date(),
    },
  };

  const jobsDb: Record<string, any> = {};
  const dispatchesDb: Record<string, any> = {};

  beforeAll(async () => {
    // 1. Mock Printer methods
    vi.spyOn(prisma.printer, 'findUnique').mockImplementation(async (args: any) => {
      return printersDb[args.where.id] || null;
    });

    vi.spyOn(prisma.printer, 'update').mockImplementation(async (args: any) => {
      const p = printersDb[args.where.id];
      if (!p) throw new Error('Printer not found');
      Object.assign(p, args.data);
      return p;
    });

    vi.spyOn(prisma.printer, 'findMany').mockImplementation(async (args: any) => {
      return Object.values(printersDb);
    });

    vi.spyOn(prisma.printerAgent, 'findFirst').mockImplementation(async () => null);
    vi.spyOn(prisma.printerAgent, 'updateMany').mockImplementation(async () => ({ count: 1 }));

    // 2. Mock PrintJob methods
    vi.spyOn(prisma.printJob, 'findFirst').mockImplementation(async (args: any) => {
      const printerId = args.where.printerId;
      const status = args.where.status;

      const matched = Object.values(jobsDb).find(
        (j) => j.printerId === printerId && j.status === status
      );

      if (!matched) return null;
      return {
        ...matched,
        settings: matched.settings || {
          copies: 1,
          isColor: false,
          isDuplex: true,
          pageSize: 'A4',
          pageRange: 'all',
          fitToPage: true,
          orientation: 'portrait',
        },
        assetVersion: {
          id: matched.assetVersionId || 'v1',
          pageCount: 4,
          checksumSha256: 'sha-sample-999',
          storageKey: 'uploads/user-1/doc/test.pdf',
          asset: {
            mimeType: 'application/pdf',
            originalFileName: 'contract.pdf',
          },
        },
      };
    });

    vi.spyOn(prisma.printJob, 'findUnique').mockImplementation(async (args: any) => {
      const job = jobsDb[args.where.id];
      if (!job) return null;
      const dispatches = Object.values(dispatchesDb).filter((d) => d.printJobId === job.id);
      return {
        ...job,
        dispatches,
      };
    });

    vi.spyOn(prisma.printJob, 'update').mockImplementation(async (args: any) => {
      const job = jobsDb[args.where.id];
      if (!job) throw new Error('Job not found');
      Object.assign(job, args.data);
      return job;
    });

    // 3. Mock PrinterDispatch methods
    vi.spyOn(prisma.printerDispatch, 'create').mockImplementation(async (args: any) => {
      const id = 'disp-' + Math.random().toString(36).substring(2, 9);
      const dispatch = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
      dispatchesDb[id] = dispatch;
      return dispatch;
    });

    vi.spyOn(prisma.printerDispatch, 'update').mockImplementation(async (args: any) => {
      const d = dispatchesDb[args.where.id];
      if (!d) throw new Error('Dispatch not found');
      Object.assign(d, args.data, { updatedAt: new Date() });
      return d;
    });

    vi.spyOn(prisma.auditEvent, 'create').mockImplementation(async (args: any) => ({
      id: 'audit-' + Math.random().toString(36).substring(2, 9),
      ...args.data,
      createdAt: new Date(),
    }));

    vi.spyOn(prisma.$transaction, 'call').mockImplementation(async (callback: any) => callback(prisma));
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => callback(prisma));

    app = await buildApp();
    await app.ready();
  });

  // ---------------------------------------------------------------------------
  // 1. Agent Authentication & Security
  // ---------------------------------------------------------------------------
  describe('Printer Agent Security & Authentication', () => {
    it('Rejects unauthenticated agent polling with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agent/jobs/claim',
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('AGENT_UNAUTHORIZED');
    });

    it('Rejects agent polling with invalid secret header (401)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agent/jobs/claim',
        headers: {
          'x-agent-secret': 'invalid_secret_key_123456789',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('AGENT_INVALID_CREDENTIALS');
    });

    it('Returns null job when no queued jobs exist for the printer', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agent/jobs/claim',
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'lab-mono-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.job).toBeNull();
      expect(body.data.pollIntervalSeconds).toBe(5);
      expect(body.data.printer.id).toBe('lab-mono-01');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Successful Job Claiming & Signed Download Package
  // ---------------------------------------------------------------------------
  describe('Job Claiming & Short-Lived Signed Package Generation', () => {
    let queuedJobId: string;

    beforeAll(() => {
      // Pre-seed an unpaid draft job (MUST NOT be claimable)
      jobsDb['job-unpaid-draft'] = {
        id: 'job-unpaid-draft',
        shortCode: 'DRF-001',
        printerId: 'library-a4-01',
        status: 'draft', // Not paid!
        createdAt: new Date(Date.now() - 10000),
      };

      // Pre-seed an awaiting_payment job (MUST NOT be claimable)
      jobsDb['job-awaiting-pay'] = {
        id: 'job-awaiting-pay',
        shortCode: 'PAY-002',
        printerId: 'library-a4-01',
        status: 'awaiting_payment', // Not paid!
        createdAt: new Date(Date.now() - 5000),
      };

      // Pre-seed a paid and verified queued job (ELIGIBLE FOR CLAIM)
      queuedJobId = 'job-paid-queued-1';
      jobsDb[queuedJobId] = {
        id: queuedJobId,
        shortCode: 'QUE-777',
        printerId: 'library-a4-01',
        status: 'queued', // Paid, approved, and ready!
        retryCount: 0,
        settings: {
          copies: 2,
          isColor: true,
          isDuplex: true,
          pageSize: 'A4',
          pageRange: 'all',
          fitToPage: true,
          orientation: 'portrait',
        },
        assetVersionId: 'version-sample',
        createdAt: new Date(),
      };
    });

    it('Claims only the paid and queued job, ignores draft/unpaid jobs, and generates signed package URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agent/jobs/claim',
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'library-a4-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.job).toBeDefined();
      expect(body.data.job.jobId).toBe(queuedJobId);
      expect(body.data.job.shortCode).toBe('QUE-777');
      expect(body.data.job.dispatchId).toBeDefined();

      // Verify signed download package URL
      expect(body.data.job.packageUrl).toBeDefined();
      expect(body.data.job.packageUrlExpiresAt).toBeDefined();

      // Verify hardware print instructions
      expect(body.data.job.settings.copies).toBe(2);
      expect(body.data.job.settings.isColor).toBe(true);
      expect(body.data.job.settings.isDuplex).toBe(true);
      expect(body.data.job.document.pageCount).toBe(4);
      expect(body.data.job.document.checksumSha256).toBe('sha-sample-999');

      // Verify job transitioned to claimed_by_printer in DB
      expect(jobsDb[queuedJobId].status).toBe('claimed_by_printer');
    });

    it('Cross-Printer Isolation: Agent for lab-mono-01 cannot claim job assigned to library-a4-01', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agent/jobs/claim',
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'lab-mono-01',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.job).toBeNull(); // No jobs for lab-mono-01!
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Status Reporting Progression: printing -> completed
  // ---------------------------------------------------------------------------
  describe('POST /v1/agent/jobs/:id/status (Progression)', () => {
    let activeJobId: string;

    beforeAll(() => {
      activeJobId = 'job-active-progression';
      jobsDb[activeJobId] = {
        id: activeJobId,
        printerId: 'library-a4-01',
        status: 'claimed_by_printer',
        retryCount: 0,
      };

      dispatchesDb['disp-active'] = {
        id: 'disp-active',
        printJobId: activeJobId,
        printerId: 'library-a4-01',
        dispatchStatus: 'claimed',
      };
    });

    it('Agent reports printing status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent/jobs/${activeJobId}/status`,
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'library-a4-01',
        },
        payload: {
          status: 'printing',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.reportedStatus).toBe('printing');
      expect(jobsDb[activeJobId].status).toBe('printing');
      expect(dispatchesDb['disp-active'].dispatchStatus).toBe('acked');
    });

    it('Agent reports completed status', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent/jobs/${activeJobId}/status`,
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'library-a4-01',
        },
        payload: {
          status: 'completed',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.reportedStatus).toBe('completed');
      expect(jobsDb[activeJobId].status).toBe('completed');
      expect(dispatchesDb['disp-active'].dispatchStatus).toBe('printed');
      expect(dispatchesDb['disp-active'].printedAt).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Hardware Failure & Retry Policy
  // ---------------------------------------------------------------------------
  describe('Hardware Failure & Retry Policy', () => {
    let failingJobId: string;

    beforeAll(() => {
      failingJobId = 'job-failing-hw';
      jobsDb[failingJobId] = {
        id: failingJobId,
        printerId: 'library-a4-01',
        status: 'claimed_by_printer',
        retryCount: 0,
      };

      dispatchesDb['disp-failing'] = {
        id: 'disp-failing',
        printJobId: failingJobId,
        printerId: 'library-a4-01',
        dispatchStatus: 'claimed',
      };
    });

    it('First failure re-queues job for automatic retry (retryCount < 3)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent/jobs/${failingJobId}/status`,
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'library-a4-01',
        },
        payload: {
          status: 'failed',
          failureReason: 'Paper tray empty',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(jobsDb[failingJobId].retryCount).toBe(1);
      expect(jobsDb[failingJobId].status).toBe('queued'); // Automatically re-queued!
    });

    it('Exceeding retry threshold (retryCount >= 3) marks job as permanently failed', async () => {
      // Simulate 2 more failures
      jobsDb[failingJobId].retryCount = 2;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/agent/jobs/${failingJobId}/status`,
        headers: {
          'x-agent-secret': config.PRINT_AGENT_SHARED_SECRET,
          'x-printer-id': 'library-a4-01',
        },
        payload: {
          status: 'failed',
          failureReason: 'Persistent optical sensor error',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(jobsDb[failingJobId].retryCount).toBe(3);
      expect(jobsDb[failingJobId].status).toBe('failed'); // Permanently failed!
      expect(jobsDb[failingJobId].failureReason).toContain('sensor error');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Printer Offline Detection & Heartbeat
  // ---------------------------------------------------------------------------
  describe('Printer Offline Detection', () => {
    it('detectOfflinePrinters detects printers with stale heartbeats and marks them offline', async () => {
      printersDb['stale-printer-99'] = {
        id: 'stale-printer-99',
        name: 'Dorm Printer',
        status: 'online',
        lastHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000), // 10 minutes ago!
      };

      const offlineIds = await detectOfflinePrinters(5);
      expect(offlineIds).toContain('stale-printer-99');
      expect(printersDb['stale-printer-99'].status).toBe('offline');
    });
  });
});
