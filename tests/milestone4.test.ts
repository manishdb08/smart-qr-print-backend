process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://smartqr:smartqr_secret@localhost:5432/smart_qr_print?schema=public';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';
import { PRICING_RULES, config } from '../src/config/index.js';
import {
  generatePaymentSignature,
  generateWebhookSignature,
} from '../src/payments/razorpayClient.js';
import { reconcilePendingPayments } from '../src/modules/payments/payment.service.js';

describe('Milestone 4: Print Jobs, Pricing Quotes & Razorpay Integration Tests', () => {
  let app: FastifyInstance;

  // In-memory repositories
  const jobsDb: Record<string, any> = {};
  const settingsDb: Record<string, any> = {};
  const quotesDb: Record<string, any> = {};
  const razorpayOrdersDb: Record<string, any> = {};
  const paymentEventsDb: Record<string, any> = {};

  const testPrinters: Record<string, any> = {
    'library-a4-01': {
      id: 'library-a4-01',
      name: 'Central Library Color Printer',
      status: 'online',
      location: '1st Floor',
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
      name: 'CS Lab Mono Printer',
      status: 'online',
      location: 'Room 204',
      capabilities: {
        id: 'cap-2',
        printerId: 'lab-mono-01',
        supportsColor: false, // MONO ONLY!
        supportsMono: true,
        supportsDuplex: true,
        supportedPageSizes: ['A4'],
        maxDpi: 600,
      },
    },
  };

  const testAssetVersions: Record<string, any> = {
    'version-5-pages': {
      id: 'version-5-pages',
      assetId: 'asset-1',
      versionNumber: 1,
      pageCount: 5,
      fileSizeBytes: 20000,
      storageKey: 'uploads/user-customer-1/v5/test.pdf',
      isApproved: true,
      asset: {
        id: 'asset-1',
        userId: 'user-customer-1',
      },
    },
  };

  beforeAll(async () => {
    vi.spyOn(prisma.user, 'findFirst').mockImplementation(async (args: any) => {
      const email = args?.where?.email;
      if (!email) return null;
      const role = email.split('@')[0];
      return {
        id: role === 'customer' ? 'user-customer-1' : `mock-user-${role}`,
        email,
        role,
        name: `Mock ${role}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;
    });

    vi.spyOn(prisma.printer, 'findUnique').mockImplementation(async (args: any) => {
      return testPrinters[args.where.id] || null;
    });

    vi.spyOn(prisma.assetVersion, 'findUnique').mockImplementation(async (args: any) => {
      return testAssetVersions[args.where.id] || null;
    });

    vi.spyOn(prisma.printJob, 'create').mockImplementation(async (args: any) => {
      const id = 'job-' + Math.random().toString(36).substring(2, 9);
      const job = {
        id,
        ...args.data,
        totalAmountPaise: null,
        retryCount: 0,
        failureReason: null,
        expiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      jobsDb[id] = job;
      return job;
    });

    vi.spyOn(prisma.printSettings, 'create').mockImplementation(async (args: any) => {
      const id = 'set-' + Math.random().toString(36).substring(2, 9);
      const settings = { id, ...args.data };
      settingsDb[args.data.printJobId] = settings;
      return settings;
    });

    vi.spyOn(prisma.priceQuote, 'create').mockImplementation(async (args: any) => {
      const id = 'quote-' + Math.random().toString(36).substring(2, 9);
      const quote = { id, ...args.data, createdAt: new Date() };
      quotesDb[args.data.printJobId] = quote;
      return quote;
    });

    vi.spyOn(prisma.razorpayOrder, 'create').mockImplementation(async (args: any) => {
      const id = 'rzp-order-' + Math.random().toString(36).substring(2, 9);
      const rzpOrder = { id, ...args.data, createdAt: new Date(), updatedAt: new Date() };
      razorpayOrdersDb[args.data.razorpayOrderId] = rzpOrder;
      return rzpOrder;
    });

    vi.spyOn(prisma.razorpayOrder, 'findUnique').mockImplementation(async (args: any) => {
      const order = razorpayOrdersDb[args.where.razorpayOrderId];
      if (!order) return null;
      const job = jobsDb[order.printJobId];
      return {
        ...order,
        printJob: job,
      };
    });

    vi.spyOn(prisma.razorpayOrder, 'update').mockImplementation(async (args: any) => {
      const found = Object.values(razorpayOrdersDb).find((o) => o.id === args.where.id);
      if (!found) throw new Error('Order not found');
      Object.assign(found, args.data);
      return found;
    });

    vi.spyOn(prisma.paymentEvent, 'findUnique').mockImplementation(async (args: any) => {
      return paymentEventsDb[args.where.eventId] || null;
    });

    vi.spyOn(prisma.paymentEvent, 'create').mockImplementation(async (args: any) => {
      const event = { id: 'evt-' + Math.random().toString(36).substring(2, 9), ...args.data };
      paymentEventsDb[args.data.eventId] = event;
      return event;
    });

    vi.spyOn(prisma.paymentEvent, 'upsert').mockImplementation(async (args: any) => {
      const event = { id: 'evt-' + Math.random().toString(36).substring(2, 9), ...args.create };
      paymentEventsDb[args.create.eventId] = event;
      return event;
    });

    vi.spyOn(prisma.auditEvent, 'create').mockImplementation(async (args: any) => ({
      id: 'audit-' + Math.random().toString(36).substring(2, 9),
      ...args.data,
      createdAt: new Date(),
    }));

    vi.spyOn(prisma.printJob, 'findUnique').mockImplementation(async (args: any) => {
      const job = jobsDb[args.where.id];
      if (!job) return null;
      const printer = testPrinters[job.printerId];
      const settings = settingsDb[job.id];
      const assetVersion = testAssetVersions[job.assetVersionId];
      const quote = quotesDb[job.id];
      const rzpOrders = Object.values(razorpayOrdersDb).filter((o) => o.printJobId === job.id);
      return {
        ...job,
        settings,
        printer,
        assetVersion,
        priceQuotes: quote ? [quote] : [],
        razorpayOrders: rzpOrders,
      };
    });

    vi.spyOn(prisma.printJob, 'findMany').mockImplementation(async (args: any) => {
      let jobs = Object.values(jobsDb);
      if (args?.where?.status) {
        jobs = jobs.filter((j) => j.status === args.where.status);
      }
      return jobs.map((job) => ({
        ...job,
        settings: settingsDb[job.id],
        printer: testPrinters[job.printerId],
        assetVersion: testAssetVersions[job.assetVersionId],
        priceQuotes: quotesDb[job.id] ? [quotesDb[job.id]] : [],
      }));
    });

    vi.spyOn(prisma.printJob, 'update').mockImplementation(async (args: any) => {
      const job = jobsDb[args.where.id];
      if (!job) throw new Error('Job not found');
      Object.assign(job, args.data);
      return job;
    });

    vi.spyOn(prisma.$transaction, 'call').mockImplementation(async (callback: any) => {
      return callback(prisma);
    });

    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      return callback(prisma);
    });

    app = await buildApp();
    await app.ready();
  });

  // ---------------------------------------------------------------------------
  // 1. Draft Print Job Creation
  // ---------------------------------------------------------------------------
  describe('POST /v1/print-jobs', () => {
    it('Creates a draft print job from approved asset version and assigns kiosk shortCode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'library-a4-01',
          copies: 2,
          isColor: true,
          isDuplex: true,
          pageSize: 'A4',
          pageRange: 'all',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBeDefined();
      expect(body.data.shortCode).toMatch(/^[A-Z0-9]{2,3}-[A-Z0-9]{2,4}$/);
      expect(body.data.status).toBe('draft');
      expect(body.data.settings.copies).toBe(2);
      expect(body.data.settings.isColor).toBe(true);
      expect(body.data.settings.isDuplex).toBe(true);
    });

    it('Rejects draft creation for non-existent printer with 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'non-existent-printer',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('not found');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Pricing Quote & Tampering Prevention
  // ---------------------------------------------------------------------------
  describe('POST /v1/print-jobs/:id/quote (Pricing Engine)', () => {
    let monoJobId: string;
    let colorJobId: string;

    beforeAll(async () => {
      // 1. Mono job: 5 pages, 1 copy, duplex on lab-mono-01
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'lab-mono-01',
          copies: 1,
          isColor: false,
          isDuplex: true,
          pageSize: 'A4',
        },
      });
      monoJobId = JSON.parse(res1.payload).data.id;

      // 2. Color job: 5 pages, 2 copies, single-sided on library-a4-01
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'library-a4-01',
          copies: 2,
          isColor: true,
          isDuplex: false,
          pageSize: 'A4',
        },
      });
      colorJobId = JSON.parse(res2.payload).data.id;
    });

    it('Calculates mono duplex pricing: 5 pages * 200 = 1000 paise - 10% duplex discount = 900 paise', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${monoJobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('awaiting_payment');
      expect(body.data.quote.pricingRuleVersion).toBe('v1.0.0');
      expect(body.data.quote.subtotalPaise).toBe(1000); // 5 * 200
      expect(body.data.quote.discountPaise).toBe(100);  // 10% of 1000
      expect(body.data.quote.totalAmountPaise).toBe(900); // strictly integer paise!
    });

    it('Calculates color single-sided pricing: 10 pages * 800 paise = 8000 paise', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${colorJobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.quote.subtotalPaise).toBe(8000); // 5 pages * 2 copies * 800 paise
      expect(body.data.quote.discountPaise).toBe(0);
      expect(body.data.quote.totalAmountPaise).toBe(8000);
    });

    it('Hardware Capability Enforcement: Rejects color request on mono-only printer lab-mono-01 (422)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'lab-mono-01',
          isColor: true, // Unsupported on lab-mono-01!
        },
      });

      const newJobId = JSON.parse(res.payload).data.id;

      const quoteRes = await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${newJobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(quoteRes.statusCode).toBe(422);
      const body = JSON.parse(quoteRes.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('does not support color printing');
    });

    it('Hardware Capability Enforcement: Rejects unsupported paper size (422)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'library-a4-01',
          pageSize: 'Letter', // Unsupported paper size!
        },
      });

      const newJobId = JSON.parse(res.payload).data.id;

      const quoteRes = await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${newJobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(quoteRes.statusCode).toBe(422);
      const body = JSON.parse(quoteRes.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Paper size');
    });

    it('Price Tampering Prevention: Client cannot supply or override price', async () => {
      // The quote endpoint takes NO price in the body and computes exclusively from DB & rule version
      const res = await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${monoJobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          totalAmountPaise: 1, // Tampering attempt: 1 paise!
          subtotalPaise: 1,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.quote.totalAmountPaise).toBe(900); // Completely ignored tampered payload!
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Razorpay Orders & HMAC Verification
  // ---------------------------------------------------------------------------
  describe('Razorpay Orders & HMAC Signature Verification', () => {
    let quotedJobId: string;
    let rzpOrderId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'library-a4-01',
          copies: 1,
          isColor: false,
          isDuplex: false,
        },
      });
      quotedJobId = JSON.parse(res.payload).data.id;

      await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${quotedJobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
      });
    });

    it('POST /v1/payments/razorpay/orders creates gateway order strictly from quote amount (1000 paise)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/razorpay/orders',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          printJobId: quotedJobId,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.orderId).toBeDefined();
      expect(body.data.amountPaise).toBe(1000); // 5 pages * 200
      expect(body.data.keyId).toBe(config.RAZORPAY_KEY_ID);
      rzpOrderId = body.data.orderId;
    });

    it('POST /v1/payments/razorpay/verify verifies valid HMAC signature and transitions job to queued', async () => {
      const paymentId = 'pay_test_999888';
      const validSignature = generatePaymentSignature(rzpOrderId, paymentId);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/razorpay/verify',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          printJobId: quotedJobId,
          razorpay_order_id: rzpOrderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: validSignature,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('paid');
      expect(body.data.jobStatus).toBe('queued');
    });

    it('POST /v1/payments/razorpay/verify rejects forged/tampered signature (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/payments/razorpay/verify',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          printJobId: quotedJobId,
          razorpay_order_id: rzpOrderId,
          razorpay_payment_id: 'pay_test_forged',
          razorpay_signature: 'invalid_forged_hmac_signature_hex_value_00000000000000000000000000000000',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Invalid Razorpay payment signature');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Razorpay Webhooks & Idempotent Deduplication
  // ---------------------------------------------------------------------------
  describe('POST /v1/webhooks/razorpay', () => {
    let webhookOrderId: string;
    let webhookJobId: string;

    beforeAll(async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'library-a4-01',
        },
      });
      webhookJobId = JSON.parse(res1.payload).data.id;

      await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${webhookJobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      const orderRes = await app.inject({
        method: 'POST',
        url: '/v1/payments/razorpay/orders',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: { printJobId: webhookJobId },
      });
      webhookOrderId = JSON.parse(orderRes.payload).data.orderId;
    });

    it('Rejects webhook with missing or invalid signature (401)', async () => {
      const payload = JSON.stringify({ event: 'order.paid' });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/razorpay',
        headers: {
          'x-razorpay-signature': 'wrong_sig',
          'content-type': 'application/json',
        },
        payload,
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Invalid Razorpay webhook signature');
    });

    it('Processes verified order.paid webhook and marks job as queued', async () => {
      const webhookEventId = 'evt_test_unique_001';
      const payloadObj = {
        id: webhookEventId,
        event: 'order.paid',
        payload: {
          order: {
            entity: {
              id: webhookOrderId,
              amount: 1000,
              status: 'paid',
            },
          },
        },
      };

      const rawBody = JSON.stringify(payloadObj);
      const validSig = generateWebhookSignature(rawBody);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/razorpay',
        headers: {
          'x-razorpay-signature': validSig,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.received).toBe(true);
      expect(body.eventId).toBe(webhookEventId);
    });

    it('Idempotent Webhook Replay: Duplicate webhook delivery is deduplicated without error', async () => {
      const webhookEventId = 'evt_test_unique_001'; // Same event ID as previous test!
      const payloadObj = {
        id: webhookEventId,
        event: 'order.paid',
        payload: {
          order: {
            entity: {
              id: webhookOrderId,
              amount: 1000,
            },
          },
        },
      };

      const rawBody = JSON.stringify(payloadObj);
      const validSig = generateWebhookSignature(rawBody);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/razorpay',
        headers: {
          'x-razorpay-signature': validSig,
          'content-type': 'application/json',
        },
        payload: rawBody,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.received).toBe(true);
      expect(body.deduplicated).toBe(true); // Recognized as duplicate!
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Refund Support & Payment Reconciliation
  // ---------------------------------------------------------------------------
  describe('Refund Support & Payment Reconciliation', () => {
    it('Processes customer refund request for paid job and marks status as refunded', async () => {
      // Create and pay for a job
      const res = await app.inject({
        method: 'POST',
        url: '/v1/print-jobs',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          assetVersionId: 'version-5-pages',
          printerId: 'library-a4-01',
        },
      });
      const jobId = JSON.parse(res.payload).data.id;
      await app.inject({
        method: 'POST',
        url: `/v1/print-jobs/${jobId}/quote`,
        headers: { authorization: 'Bearer test-token-customer' },
      });
      const orderRes = await app.inject({
        method: 'POST',
        url: '/v1/payments/razorpay/orders',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: { printJobId: jobId },
      });
      const orderId = JSON.parse(orderRes.payload).data.orderId;

      // Mark order as paid
      razorpayOrdersDb[orderId].status = 'paid';

      const refundRes = await app.inject({
        method: 'POST',
        url: `/v1/payments/${jobId}/refund`,
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          reason: 'Paper jam at printer, output not dispensed',
        },
      });

      expect(refundRes.statusCode).toBe(200);
      const body = JSON.parse(refundRes.payload);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('refunded');
    });

    it('reconcilePendingPayments resets stale payment_pending jobs back to awaiting_payment', async () => {
      const staleJobId = 'job-stale-pending';
      jobsDb[staleJobId] = {
        id: staleJobId,
        userId: 'user-customer-1',
        printerId: 'library-a4-01',
        assetVersionId: 'version-5-pages',
        status: 'payment_pending',
        updatedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
      };

      const result = await reconcilePendingPayments();
      expect(result.reconciledCount).toBeGreaterThanOrEqual(1);
      expect(jobsDb[staleJobId].status).toBe('awaiting_payment');
    });
  });
});
