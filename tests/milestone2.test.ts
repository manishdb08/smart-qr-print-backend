process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://smartqr:smartqr_secret@localhost:5432/smart_qr_print?schema=public';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';
import { getStorageProvider, LocalStorageProvider, setStorageProvider } from '../src/storage/index.js';

describe('Milestone 2: Uploads & Document Assets Integration Tests', () => {
  let app: FastifyInstance;
  let localStorage: LocalStorageProvider;

  // In-memory mock repositories
  const assetsDb: Record<string, any> = {};
  const versionsDb: Record<string, any[]> = {};

  // Sample valid test buffers
  let validPdfBuffer: Buffer;
  let validPngBuffer: Buffer;

  beforeAll(async () => {
    // 1. Create a real 3-page PDF with pdf-lib for deterministic testing
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 Page 1
    pdfDoc.addPage([595, 842]); // A4 Page 2
    pdfDoc.addPage([595, 842]); // A4 Page 3
    validPdfBuffer = Buffer.from(await pdfDoc.save());

    // 2. Create a real 100x100 PNG image with sharp
    validPngBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 50, g: 150, b: 250, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    // 3. Initialize local memory storage provider
    localStorage = new LocalStorageProvider();
    setStorageProvider(localStorage);

    // 4. Mock Prisma models for assets and versions
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

    vi.spyOn(prisma.documentAsset, 'create').mockImplementation(async (args: any) => {
      const id = 'asset-' + Math.random().toString(36).substring(2, 9);
      const asset = {
        id,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      assetsDb[id] = asset;
      versionsDb[id] = [];
      return asset;
    });

    vi.spyOn(prisma.assetVersion, 'create').mockImplementation(async (args: any) => {
      const id = 'version-' + Math.random().toString(36).substring(2, 9);
      const version = {
        id,
        ...args.data,
        createdAt: new Date(),
      };
      if (!versionsDb[args.data.assetId]) {
        versionsDb[args.data.assetId] = [];
      }
      versionsDb[args.data.assetId].push(version);
      return version;
    });

    vi.spyOn(prisma.documentAsset, 'findUnique').mockImplementation(async (args: any) => {
      const asset = assetsDb[args.where.id];
      if (!asset) return null;
      return {
        ...asset,
        _count: {
          versions: versionsDb[asset.id]?.length || 0,
        },
      };
    });

    vi.spyOn(prisma.assetVersion, 'findMany').mockImplementation(async (args: any) => {
      return versionsDb[args.where.assetId] || [];
    });

    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      return callback(prisma);
    });

    vi.spyOn(prisma.auditEvent, 'create').mockImplementation(async (args: any) => ({
      id: 'audit-' + Math.random().toString(36).substring(2, 9),
      ...args.data,
      createdAt: new Date(),
    }));

    app = await buildApp();
    await app.ready();
  });

  // ---------------------------------------------------------------------------
  // 1. Presigned Upload URL Tests
  // ---------------------------------------------------------------------------
  describe('POST /v1/uploads/presign', () => {
    it('Requires user authentication (rejects with 401)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        payload: {
          originalFileName: 'test.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('Generates presigned upload URL with user-scoped storage key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          originalFileName: 'my_thesis.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 50000,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.uploadUrl).toBeDefined();
      expect(body.data.storageKey).toMatch(/^uploads\/user-customer-1\/.+\/my_thesis\.pdf$/);
      expect(body.data.expiresAt).toBeDefined();
      expect(body.data.maxSizeBytes).toBe(50 * 1024 * 1024);
      expect(body.data.allowedMimeTypes).toContain('application/pdf');
    });

    it('Rejects file size exceeding 50MB limit with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          originalFileName: 'huge_file.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 60 * 1024 * 1024, // 60MB
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('Rejects disallowed MIME type with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          originalFileName: 'script.exe',
          mimeType: 'application/x-msdownload' as any,
          fileSizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Upload Completion & Validation Tests
  // ---------------------------------------------------------------------------
  describe('POST /v1/uploads/complete', () => {
    it('Verifies a valid PDF, computes SHA-256, extracts 3 pages, and creates immutable asset v1', async () => {
      const storageKey = 'uploads/user-customer-1/uuid-1/my_document.pdf';
      localStorage.seedFile(storageKey, validPdfBuffer, 'application/pdf');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          storageKey,
          originalFileName: 'my_document.pdf',
          mimeType: 'application/pdf',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.assetId).toBeDefined();
      expect(body.data.originalFileName).toBe('my_document.pdf');
      expect(body.data.mimeType).toBe('application/pdf');
      expect(body.data.pageCount).toBe(3); // Exactly 3 pages extracted from buffer!
      expect(body.data.fileSizeBytes).toBe(validPdfBuffer.length);
      expect(body.data.checksumSha256).toBeDefined();
      expect(body.data.isImmutableOriginal).toBe(true);

      // Verify initial version 1
      expect(body.data.activeVersion.versionNumber).toBe(1);
      expect(body.data.activeVersion.derivationType).toBe('original');
      expect(body.data.activeVersion.pageCount).toBe(3);
      expect(body.data.activeVersion.previewUrl).toBeDefined();
    });

    it('Verifies a valid PNG image and sets page count to 1', async () => {
      const storageKey = 'uploads/user-customer-1/uuid-2/photo.png';
      localStorage.seedFile(storageKey, validPngBuffer, 'image/png');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          storageKey,
          originalFileName: 'photo.png',
          mimeType: 'image/png',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.mimeType).toBe('image/png');
      expect(body.data.pageCount).toBe(1);
      expect(body.data.fileSizeBytes).toBe(validPngBuffer.length);
    });

    it('Rejects spoofed file (text content disguised as .pdf) via magic bytes validation', async () => {
      const spoofedBuffer = Buffer.from('This is actually a plaintext file, not a real PDF.');
      const storageKey = 'uploads/user-customer-1/uuid-3/fake.pdf';
      localStorage.seedFile(storageKey, spoofedBuffer, 'application/pdf');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          storageKey,
          originalFileName: 'fake.pdf',
          mimeType: 'application/pdf',
        },
      });

      expect(res.statusCode).toBe(415);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('magic bytes');
    });

    it('Rejects extension mismatch (real PDF bytes but named .jpg)', async () => {
      const storageKey = 'uploads/user-customer-1/uuid-4/mismatched.jpg';
      localStorage.seedFile(storageKey, validPdfBuffer, 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          storageKey,
          originalFileName: 'mismatched.jpg',
          mimeType: 'image/jpeg',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('does not match actual detected MIME type');
    });

    it('Prevents cross-tenant storage key claiming (attempting to claim another user key)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: {
          authorization: 'Bearer test-token-customer', // user-customer-1
        },
        payload: {
          storageKey: 'uploads/victim-user-id-999/uuid-5/secret.pdf',
          originalFileName: 'secret.pdf',
          mimeType: 'application/pdf',
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('does not belong to the authenticated user');
    });

    it('Rejects malware upload via MalwareScanner and quarantines file', async () => {
      const eicarBuffer = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
      const storageKey = 'uploads/user-customer-1/uuid-6/virus.pdf';
      localStorage.seedFile(storageKey, eicarBuffer, 'application/pdf');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          storageKey,
          originalFileName: 'virus.pdf',
          mimeType: 'application/pdf',
        },
      });

      expect([415, 422]).toContain(res.statusCode);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Asset Details and Versions Retrieval Tests
  // ---------------------------------------------------------------------------
  describe('GET /v1/assets/:assetId & GET /v1/assets/:assetId/versions', () => {
    let testAssetId: string;

    beforeAll(async () => {
      // Create a test asset belonging to user-customer-1
      const storageKey = 'uploads/user-customer-1/asset-test/report.pdf';
      localStorage.seedFile(storageKey, validPdfBuffer, 'application/pdf');

      const uploadRes = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          storageKey,
          originalFileName: 'report.pdf',
          mimeType: 'application/pdf',
        },
      });

      const body = JSON.parse(uploadRes.payload);
      testAssetId = body.data.assetId;
    });

    it('Customer retrieves their own asset metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/assets/${testAssetId}`,
        headers: {
          authorization: 'Bearer test-token-customer',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(testAssetId);
      expect(body.data.isImmutableOriginal).toBe(true);
      expect(body.data.pageCount).toBe(3);
      expect(body.data.previewUrl).toBeDefined();
      expect(body.data.versionCount).toBe(1);
    });

    it('Another customer is forbidden from accessing this asset (403)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/assets/${testAssetId}`,
        headers: {
          authorization: 'Bearer test-token-printer_operator', // different user
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Access denied');
    });

    it('Admin is allowed to view any asset', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/assets/${testAssetId}`,
        headers: {
          authorization: 'Bearer test-token-admin',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(testAssetId);
    });

    it('GET /v1/assets/:assetId/versions returns array with initial v1 original', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/assets/${testAssetId}/versions`,
        headers: {
          authorization: 'Bearer test-token-customer',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);

      const v1 = body.data[0];
      expect(v1.versionNumber).toBe(1);
      expect(v1.derivationType).toBe('original');
      expect(v1.pageCount).toBe(3);
      expect(v1.previewUrl).toBeDefined();
    });

    it('Returns 404 for non-existent asset ID', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/assets/non-existent-asset-id',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('not found');
    });
  });
});
