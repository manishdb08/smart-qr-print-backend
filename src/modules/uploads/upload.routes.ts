import { FastifyInstance } from 'fastify';
import {
  presignUploadSchema,
  completeUploadParamSchema,
  completeUploadBodySchema,
} from './upload.types.js';
import {
  createPresignedUpload,
  completeUploadSession,
  completeUpload,
  cleanupAbandonedUploadSessions,
} from './upload.service.js';
import { authenticateUser } from '../../auth/rbac.js';
import { getStorageProvider } from '../../storage/index.js';

export async function uploadRoutes(fastify: FastifyInstance) {
  // 1. Presign Upload URL
  fastify.post(
    '/uploads/presign',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
      schema: {
        description: 'Generate a short-lived signed upload URL, uploadSessionId, and assetId for secure document upload.',
        tags: ['Uploads'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the file including extension' },
            originalFileName: { type: 'string', description: 'Alternative field for file name' },
            declaredMimeType: {
              type: 'string',
              enum: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
              description: 'MIME type of the document or image',
            },
            mimeType: {
              type: 'string',
              enum: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
              description: 'Alternative field for MIME type',
            },
            sizeBytes: { type: 'integer', description: 'Declared size in bytes (max 25MB)' },
            fileSizeBytes: { type: 'integer', description: 'Alternative field for size in bytes' },
            qrSessionToken: { type: 'string', description: 'Optional QR session token if scanning at kiosk' },
            idempotencyKey: { type: 'string', description: 'Optional client idempotency key' },
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
                  uploadSessionId: { type: 'string' },
                  assetId: { type: 'string' },
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
        filename: parsed.filename,
        originalFileName: parsed.originalFileName,
        declaredMimeType: parsed.declaredMimeType,
        mimeType: parsed.mimeType,
        sizeBytes: parsed.sizeBytes,
        fileSizeBytes: parsed.fileSizeBytes,
        qrSessionToken: parsed.qrSessionToken,
        idempotencyKey: parsed.idempotencyKey,
      });

      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // 2. Complete Upload Session (Primary Milestone 2 Endpoint)
  fastify.post(
    '/uploads/:uploadSessionId/complete',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
      preValidation: async (request) => {
        if (!request.body) {
          request.body = {};
        }
      },
      schema: {
        description: 'Marks an upload complete, validates file, creates immutable asset version, and returns status.',
        tags: ['Uploads'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['uploadSessionId'],
          properties: {
            uploadSessionId: { type: 'string', description: 'UUID of the upload session' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { uploadSessionId } = completeUploadParamSchema.parse(request.params);
      const body = (request.body as { idempotencyKey?: string }) || {};
      const userId = request.user!.id;

      const result = await completeUploadSession({
        uploadSessionId,
        userId,
        idempotencyKey: body.idempotencyKey,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(200).send({
        success: true,
        data: result,
      });
    }
  );

  // 3. Complete Upload (Backward Compatible for existing tests and clients)
  fastify.post(
    '/uploads/complete',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
      schema: {
        description: 'Legacy endpoint: finalize document upload by storageKey or uploadSessionId.',
        tags: ['Uploads'],
        security: [{ bearerAuth: [] }],
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const parsed = completeUploadBodySchema.parse(request.body);
      const userId = request.user!.id;

      const result = await completeUpload({
        userId,
        uploadSessionId: parsed.uploadSessionId,
        storageKey: parsed.storageKey,
        originalFileName: parsed.originalFileName,
        filename: parsed.filename,
        declaredMimeType: parsed.declaredMimeType,
        mimeType: parsed.mimeType,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return reply.status(201).send({
        success: true,
        data: result,
      });
    }
  );

  // 4. Trigger Cleanup of Abandoned Upload Sessions (Admin/System only)
  fastify.post(
    '/uploads/cleanup-stale',
    {
      schema: {
        description: 'Clean up abandoned upload sessions and expired upload URLs.',
        tags: ['Uploads'],
        security: [{ bearerAuth: [] }],
      },
      preHandler: [authenticateUser(true)], // Admin only
    },
    async (_request, reply) => {
      const result = await cleanupAbandonedUploadSessions();
      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // 5. Mock Storage Upload (Dev / Local Testing)
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

  // 6. Mock Storage Download (Dev / Local Testing)
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
