process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://smartqr:smartqr_secret@localhost:5432/smart_qr_print?schema=public';

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db/client.js';
import { LocalStorageProvider, setStorageProvider } from '../src/storage/index.js';
import { config } from '../src/config/index.js';

describe('Milestone 2: Uploads, Validation, Storage & Document Assets Tests', () => {
  let app: FastifyInstance;
  let localStorage: LocalStorageProvider;

  // In-memory mock repositories
  const assetsDb: Record<string, any> = {};
  const versionsDb: Record<string, any[]> = {};
  const uploadSessionsDb: Record<string, any> = {};
  const auditEventsDb: any[] = [];

  // Sample valid test buffers
  let validPdfBuffer: Buffer;
  let validPngBuffer: Buffer;
  let corruptPdfBuffer: Buffer;

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

    // 3. Create a corrupt PDF buffer (valid magic bytes %PDF but invalid/truncated content)
    corruptPdfBuffer = Buffer.from('%PDF-1.4\n%corrupt truncated body\n%%EOF');

    // 4. Initialize local memory storage provider
    localStorage = new LocalStorageProvider();
    setStorageProvider(localStorage);

    // 5. Mock Prisma models for full in-memory fidelity
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
      const id = args.data.id || 'asset-' + Math.random().toString(36).substring(2, 9);
      const asset = {
        id,
        status: args.data.status || 'pending_upload',
        isImmutableOriginal: args.data.isImmutableOriginal ?? true,
        isDeleted: args.data.isDeleted ?? false,
        deletedAt: args.data.deletedAt ?? null,
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      assetsDb[id] = asset;
      if (!versionsDb[id]) {
        versionsDb[id] = [];
      }
      return asset;
    });

    vi.spyOn(prisma.documentAsset, 'findUnique').mockImplementation(async (args: any) => {
      const asset = assetsDb[args.where.id];
      if (!asset) return null;
      const versions = versionsDb[asset.id] || [];
      return {
        ...asset,
        versions,
        _count: {
          versions: versions.length,
        },
      };
    });

    vi.spyOn(prisma.documentAsset, 'findFirst').mockImplementation(async (args: any) => {
      for (const asset of Object.values(assetsDb)) {
        if (args.where?.id && asset.id !== args.where.id) continue;
        if (args.where?.userId && asset.userId !== args.where.userId) continue;
        if (args.where?.storageKey && asset.storageKey !== args.where.storageKey) continue;
        if (args.where?.isDeleted !== undefined && asset.isDeleted !== args.where.isDeleted) continue;
        const versions = versionsDb[asset.id] || [];
        return {
          ...asset,
          versions,
          _count: { versions: versions.length },
        };
      }
      return null;
    });

    vi.spyOn(prisma.documentAsset, 'update').mockImplementation(async (args: any) => {
      const asset = assetsDb[args.where.id];
      if (!asset) throw new Error('DocumentAsset not found');
      Object.assign(asset, args.data, { updatedAt: new Date() });
      return asset;
    });

    vi.spyOn(prisma.uploadSession, 'create').mockImplementation(async (args: any) => {
      const id = args.data.id || 'session-' + Math.random().toString(36).substring(2, 9);
      const session = {
        id,
        status: args.data.status || 'pending',
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      uploadSessionsDb[id] = session;
      return session;
    });

    vi.spyOn(prisma.uploadSession, 'findUnique').mockImplementation(async (args: any) => {
      let s = args.where?.id ? uploadSessionsDb[args.where.id] : null;
      if (!s && args.where?.storageKey) {
        s = Object.values(uploadSessionsDb).find((sess) => sess.storageKey === args.where.storageKey);
      }
      if (!s && args.where?.idempotencyKey) {
        s = Object.values(uploadSessionsDb).find((sess) => sess.idempotencyKey === args.where.idempotencyKey);
      }
      if (!s) return null;
      return {
        ...s,
        asset: assetsDb[s.assetId] || null,
      };
    });

    vi.spyOn(prisma.uploadSession, 'findFirst').mockImplementation(async (args: any) => {
      for (const s of Object.values(uploadSessionsDb)) {
        if (args.where?.id && s.id !== args.where.id) continue;
        if (args.where?.idempotencyKey && s.idempotencyKey !== args.where.idempotencyKey) continue;
        if (args.where?.storageKey && s.storageKey !== args.where.storageKey) continue;
        if (args.where?.assetId && s.assetId !== args.where.assetId) continue;
        if (args.where?.userId && s.userId !== args.where.userId) continue;
        return {
          ...s,
          asset: assetsDb[s.assetId] || null,
        };
      }
      return null;
    });

    vi.spyOn(prisma.uploadSession, 'update').mockImplementation(async (args: any) => {
      const s = uploadSessionsDb[args.where.id];
      if (!s) throw new Error('UploadSession not found');
      Object.assign(s, args.data, { updatedAt: new Date() });
      return s;
    });

    vi.spyOn(prisma.assetVersion, 'create').mockImplementation(async (args: any) => {
      const id = args.data.id || 'version-' + Math.random().toString(36).substring(2, 9);
      const version = {
        id,
        status: args.data.status || 'ready',
        ...args.data,
        createdAt: new Date(),
      };
      if (!versionsDb[args.data.assetId]) {
        versionsDb[args.data.assetId] = [];
      }
      versionsDb[args.data.assetId].push(version);
      return version;
    });

    vi.spyOn(prisma.assetVersion, 'findMany').mockImplementation(async (args: any) => {
      const list = versionsDb[args.where.assetId] || [];
      return [...list].sort((a, b) => a.versionNumber - b.versionNumber);
    });

    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback: any) => {
      if (typeof callback === 'function') {
        return callback(prisma);
      }
      return Promise.all(callback);
    });

    vi.spyOn(prisma.auditEvent, 'create').mockImplementation(async (args: any) => {
      const evt = {
        id: 'audit-' + Math.random().toString(36).substring(2, 9),
        ...args.data,
        createdAt: new Date(),
      };
      auditEventsDb.push(evt);
      return evt;
    });

    app = await buildApp();
    await app.ready();
  });

  // ---------------------------------------------------------------------------
  // 1. POST /v1/uploads/presign
  // ---------------------------------------------------------------------------
  describe('POST /v1/uploads/presign', () => {
    it('Requires user authentication (rejects with 401)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        payload: {
          filename: 'test.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('Generates presigned upload URL with uploadSessionId, assetId, and user-scoped storage key', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          filename: 'my_thesis.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: 50000,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.uploadUrl).toBeDefined();
      expect(body.data.uploadSessionId).toBeDefined();
      expect(body.data.assetId).toBeDefined();
      expect(body.data.storageKey).toMatch(/^uploads\/user-customer-1\/.+\/my_thesis\.pdf$/);
      expect(body.data.expiresAt).toBeDefined();
      expect(body.data.maxSizeBytes).toBe(25 * 1024 * 1024);
      expect(body.data.allowedMimeTypes).toContain('application/pdf');
    });

    it('Rejects oversized file upload exceeding 25MB limit with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          filename: 'huge_file.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: 26 * 1024 * 1024, // 26MB exceeds 25MB
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
    });

    it('Rejects disallowed MIME type with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: {
          authorization: 'Bearer test-token-customer',
        },
        payload: {
          filename: 'script.exe',
          declaredMimeType: 'application/x-msdownload',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Upload Completion, Validation Worker & Verification
  // ---------------------------------------------------------------------------
  describe('POST /v1/uploads/:uploadSessionId/complete & POST /v1/uploads/complete', () => {
    it('Valid PDF upload becomes ready, extracts 3 pages, SHA-256, and creates immutable Version 1', async () => {
      // Step A: Presign
      const presignRes = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          filename: 'valid_doc.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: validPdfBuffer.length,
        },
      });
      expect(presignRes.statusCode).toBe(200);
      const presignData = JSON.parse(presignRes.payload).data;

      // Step B: Upload file to storage
      localStorage.seedFile(presignData.storageKey, validPdfBuffer, 'application/pdf');

      // Step C: Complete upload session
      const completeRes = await app.inject({
        method: 'POST',
        url: `/v1/uploads/${presignData.uploadSessionId}/complete`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(completeRes.statusCode).toBe(200);
      const body = JSON.parse(completeRes.payload);
      expect(body.success).toBe(true);
      expect(body.data.assetId).toBe(presignData.assetId);
      expect(body.data.status).toBe('ready');
      expect(body.data.originalFileName).toBe('valid_doc.pdf');
      expect(body.data.mimeType).toBe('application/pdf');
      expect(body.data.pageCount).toBe(3);
      expect(body.data.fileSizeBytes).toBe(validPdfBuffer.length);
      expect(body.data.checksumSha256).toBeDefined();
      expect(body.data.isImmutableOriginal).toBe(true);
      expect(body.data.activeVersion.versionNumber).toBe(1);
      expect(body.data.activeVersion.derivationType).toBe('original');
      expect(body.data.activeVersion.pageCount).toBe(3);
    });

    it('Upload completion remains safe if requested twice (Idempotency)', async () => {
      // Presign
      const presignRes = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          filename: 'idempotent_test.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: validPdfBuffer.length,
          idempotencyKey: 'idemp-key-12345',
        },
      });
      const presignData = JSON.parse(presignRes.payload).data;
      localStorage.seedFile(presignData.storageKey, validPdfBuffer, 'application/pdf');

      // First complete call
      const res1 = await app.inject({
        method: 'POST',
        url: `/v1/uploads/${presignData.uploadSessionId}/complete`,
        headers: { authorization: 'Bearer test-token-customer' },
      });
      expect(res1.statusCode).toBe(200);

      // Second complete call (duplicate/retry)
      const res2 = await app.inject({
        method: 'POST',
        url: `/v1/uploads/${presignData.uploadSessionId}/complete`,
        headers: { authorization: 'Bearer test-token-customer' },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.payload);
      expect(body2.success).toBe(true);
      expect(body2.data.assetId).toBe(presignData.assetId);
      expect(body2.data.status).toBe('ready');
      // Verify no duplicate version created
      const versions = versionsDb[presignData.assetId] || [];
      expect(versions.length).toBe(1);
    });

    it('Fake PDF extension is rejected by magic-byte verification (415)', async () => {
      const spoofedBuffer = Buffer.from('Plain text file masquerading as a PDF');
      const presignRes = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          filename: 'fake.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: spoofedBuffer.length,
        },
      });
      const presignData = JSON.parse(presignRes.payload).data;
      localStorage.seedFile(presignData.storageKey, spoofedBuffer, 'application/pdf');

      const completeRes = await app.inject({
        method: 'POST',
        url: `/v1/uploads/${presignData.uploadSessionId}/complete`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(completeRes.statusCode).toBe(415);
      const body = JSON.parse(completeRes.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('magic bytes');
    });

    it('Corrupt PDF is rejected with 422', async () => {
      const presignRes = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          filename: 'corrupted.pdf',
          declaredMimeType: 'application/pdf',
          sizeBytes: corruptPdfBuffer.length,
        },
      });
      const presignData = JSON.parse(presignRes.payload).data;
      localStorage.seedFile(presignData.storageKey, corruptPdfBuffer, 'application/pdf');

      const completeRes = await app.inject({
        method: 'POST',
        url: `/v1/uploads/${presignData.uploadSessionId}/complete`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(completeRes.statusCode).toBe(422);
      const body = JSON.parse(completeRes.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Corrupted or invalid PDF');
    });

    it('Verifies a valid PNG image and extracts dimensions and sets page count to 1', async () => {
      const presignRes = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: { authorization: 'Bearer test-token-customer' },
        payload: {
          filename: 'photo.png',
          declaredMimeType: 'image/png',
          sizeBytes: validPngBuffer.length,
        },
      });
      const presignData = JSON.parse(presignRes.payload).data;
      localStorage.seedFile(presignData.storageKey, validPngBuffer, 'image/png');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/uploads/${presignData.uploadSessionId}/complete`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.mimeType).toBe('image/png');
      expect(body.data.pageCount).toBe(1);
      expect(body.data.width).toBe(100);
      expect(body.data.height).toBe(100);
    });

    it('Rejects extension mismatch (real PDF bytes but declared as .jpg)', async () => {
      const storageKey = 'uploads/user-customer-1/uuid-mismatch/mismatched.jpg';
      localStorage.seedFile(storageKey, validPdfBuffer, 'image/jpeg');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: { authorization: 'Bearer test-token-customer' },
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
        headers: { authorization: 'Bearer test-token-customer' },
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
      const storageKey = 'uploads/user-customer-1/uuid-eicar/virus.pdf';
      localStorage.seedFile(storageKey, eicarBuffer, 'application/pdf');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: { authorization: 'Bearer test-token-customer' },
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
  // 3. Asset Details, Versions, Download URLs & Soft Delete
  // ---------------------------------------------------------------------------
  describe('Asset Details, Download URLs, Immutability & Soft Deletion', () => {
    let testAssetId: string;

    beforeAll(async () => {
      const storageKey = 'uploads/user-customer-1/asset-test/report.pdf';
      localStorage.seedFile(storageKey, validPdfBuffer, 'application/pdf');

      const uploadRes = await app.inject({
        method: 'POST',
        url: '/v1/uploads/complete',
        headers: { authorization: 'Bearer test-token-customer' },
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
        headers: { authorization: 'Bearer test-token-customer' },
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

    it('Unauthorized user cannot access another user’s asset (403)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/assets/${testAssetId}`,
        headers: { authorization: 'Bearer test-token-customer-2' }, // different customer
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
        headers: { authorization: 'Bearer test-token-admin' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(testAssetId);
    });

    it('GET /v1/assets/:assetId/versions returns array with initial v1 original and immutability', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/assets/${testAssetId}/versions`,
        headers: { authorization: 'Bearer test-token-customer' },
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
      expect(v1.status).toBe('ready');
    });

    it('Asset original cannot be overwritten', async () => {
      const asset = assetsDb[testAssetId];
      expect(asset.isImmutableOriginal).toBe(true);

      const versions = versionsDb[testAssetId] || [];
      const originalVersion = versions.find((v: any) => v.versionNumber === 1);
      expect(originalVersion).toBeDefined();
      expect(originalVersion.derivationType).toBe('original');
      // Original version retains its original storage key and checksum
      expect(originalVersion.storageKey).toBe(asset.storageKey);
    });

    it('Owner can obtain short-lived signed download URL via POST /v1/assets/:assetId/download-url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/assets/${testAssetId}/download-url`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data.downloadUrl).toBeDefined();
      expect(body.data.expiresInSeconds).toBe(900);
      expect(body.data.mimeType).toBe('application/pdf');
    });

    it('Unauthorized user cannot generate download URL for another user’s asset (403)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/assets/${testAssetId}/download-url`,
        headers: { authorization: 'Bearer test-token-other-customer' },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain('Access denied');
    });

    it('Soft-deletes asset via DELETE /v1/assets/:assetId and retains audit evidence', async () => {
      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/v1/assets/${testAssetId}`,
        headers: { authorization: 'Bearer test-token-customer' },
      });

      expect(deleteRes.statusCode).toBe(200);
      const deleteBody = JSON.parse(deleteRes.payload);
      expect(deleteBody.success).toBe(true);
      expect(deleteBody.message).toContain('soft-deleted');

      // Subsequent retrieval returns 404
      const getRes = await app.inject({
        method: 'GET',
        url: `/v1/assets/${testAssetId}`,
        headers: { authorization: 'Bearer test-token-customer' },
      });
      expect(getRes.statusCode).toBe(404);

      // Audit evidence is preserved
      const auditEvent = auditEventsDb.find(
        (e) => e.entityId === testAssetId && e.action === 'DELETION_REQUESTED'
      );
      expect(auditEvent).toBeDefined();
      expect(auditEvent.metadata.softDeleted).toBe(true);
    });
  });
});
