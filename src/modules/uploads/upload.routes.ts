import { FastifyInstance } from 'fastify';
import { presignUploadSchema, completeUploadSchema } from './upload.types.js';
import { createPresignedUpload, completeUpload } from './upload.service.js';
import { authenticateUser } from '../../auth/rbac.js';
import { getStorageProvider } from '../../storage/index.js';

export async function uploadRoutes(fastify: FastifyInstance) {
  // 1. Presign Upload URL
  fastify.post(
    '/uploads/presign',
    {
      schema: {
        description: 'Generate a short-lived signed upload URL for document upload.',
        tags: ['Uploads'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['originalFileName', 'mimeType', 'fileSizeBytes'],
          properties: {
            originalFileName: { type: 'string', description: 'Name of the file including extension' },
            mimeType: {
              type: 'string',
              enum: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
              description: 'MIME type of the document or image',
            },
            fileSizeBytes: { type: 'integer', description: 'Declared size in bytes (max 50MB)' },
            qrSessionToken: { type: 'string', description: 'Optional QR session token if scanning at kiosk' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  uploadUrl: { type: 'string' },
                  storageKey: { type: 'string' },
                  expiresAt: { type: 'string' },
                  maxSizeBytes: { type: 'number' },
                  allowedMimeTypes: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const parsed = presignUploadSchema.parse(request.body);
      const userId = request.user!.id;

      const result = await createPresignedUpload({
        userId,
        originalFileName: parsed.originalFileName,
        mimeType: parsed.mimeType,
        fileSizeBytes: parsed.fileSizeBytes,
        qrSessionToken: parsed.qrSessionToken,
      });

      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // 2. Complete Upload & Asynchronous Verification
  fastify.post(
    '/uploads/complete',
    {
      schema: {
        description: 'Finalize document upload, verifying magic bytes, SHA-256 checksum, page count, and malware scans.',
        tags: ['Uploads'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['storageKey', 'originalFileName', 'mimeType'],
          properties: {
            storageKey: { type: 'string', description: 'Key where the file was uploaded in object storage' },
            originalFileName: { type: 'string', description: 'Original file name' },
            mimeType: { type: 'string', description: 'Declared MIME type' },
            qrSessionToken: { type: 'string', description: 'Optional QR session token' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  assetId: { type: 'string' },
                  originalFileName: { type: 'string' },
                  mimeType: { type: 'string' },
                  pageCount: { type: 'number' },
                  fileSizeBytes: { type: 'number' },
                  checksumSha256: { type: 'string' },
                  isImmutableOriginal: { type: 'boolean' },
                  activeVersion: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      versionNumber: { type: 'number' },
                      derivationType: { type: 'string' },
                      pageCount: { type: 'number' },
                      fileSizeBytes: { type: 'number' },
                      checksumSha256: { type: 'string' },
                      previewUrl: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const parsed = completeUploadSchema.parse(request.body);
      const userId = request.user!.id;

      const result = await completeUpload({
        userId,
        storageKey: parsed.storageKey,
        originalFileName: parsed.originalFileName,
        declaredMimeType: parsed.mimeType,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(201).send({
        success: true,
        data: result,
      });
    }
  );

  // 3. Mock Storage Upload (Dev / Local Testing)
  fastify.put(
    '/mock-storage/upload',
    async (request, reply) => {
      const { key } = request.query as { key: string };
      const buffer = request.body as Buffer;
      const mime = (request.headers['content-type'] as string) || 'application/octet-stream';
      const storage = getStorageProvider();
      await storage.putFileBuffer(key, buffer, mime);
      return reply.send({ success: true, message: 'File written to local storage.' });
    }
  );

  // 4. Mock Storage Download (Dev / Local Testing)
  fastify.get(
    '/mock-storage/download',
    async (request, reply) => {
      const { key } = request.query as { key: string };
      const storage = getStorageProvider();
      const buffer = await storage.getFileBuffer(key);
      const meta = await storage.getFileMetadata(key);
      reply.header('Content-Type', meta.contentType || 'application/octet-stream');
      return reply.send(buffer);
    }
  );
}
