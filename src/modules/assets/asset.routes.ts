import { FastifyInstance } from 'fastify';
import { assetParamSchema } from './asset.types.js';
import {
  getAssetById,
  getAssetVersions,
  getAssetDownloadUrl,
  softDeleteAsset,
} from './asset.service.js';
import { authenticateUser } from '../../auth/rbac.js';

export async function assetRoutes(fastify: FastifyInstance) {
  // 1. Get Asset by ID
  fastify.get(
    '/assets/:assetId',
    {
      schema: {
        description: 'Get document asset metadata, immutable original confirmation, and signed download URL.',
        tags: ['Assets'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['assetId'],
          properties: {
            assetId: { type: 'string', description: 'Unique UUID of the document asset' },
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
                  id: { type: 'string' },
                  userId: { type: 'string' },
                  originalFileName: { type: 'string' },
                  mimeType: { type: 'string' },
                  fileSizeBytes: { type: 'number' },
                  pageCount: { type: 'number' },
                  checksumSha256: { type: 'string' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                  status: { type: 'string' },
                  isImmutableOriginal: { type: 'boolean' },
                  isDeleted: { type: 'boolean' },
                  previewUrl: { type: 'string' },
                  versionCount: { type: 'number' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { assetId } = assetParamSchema.parse(request.params);
      const asset = await getAssetById(assetId, request.user!);
      return reply.send({
        success: true,
        data: asset,
      });
    }
  );

  // 2. Get Asset Versions
  fastify.get(
    '/assets/:assetId/versions',
    {
      schema: {
        description: 'List all versions (original and derived) associated with a document asset.',
        tags: ['Assets'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['assetId'],
          properties: {
            assetId: { type: 'string', description: 'Unique UUID of the document asset' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    versionNumber: { type: 'number' },
                    derivationType: { type: 'string' },
                    operationType: { type: 'string' },
                    sourceVersionId: { type: 'string' },
                    fileSizeBytes: { type: 'number' },
                    pageCount: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    checksumSha256: { type: 'string' },
                    status: { type: 'string' },
                    isApproved: { type: 'boolean' },
                    createdById: { type: 'string' },
                    previewUrl: { type: 'string' },
                    createdAt: { type: 'string' },
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
      const { assetId } = assetParamSchema.parse(request.params);
      const versions = await getAssetVersions(assetId, request.user!);
      return reply.send({
        success: true,
        data: versions,
      });
    }
  );

  // 3. Post Asset Download URL (Short-lived signed download URL)
  fastify.post(
    '/assets/:assetId/download-url',
    {
      schema: {
        description: 'Returns a short-lived signed download URL only when authenticated user owns the asset or has an authorized role.',
        tags: ['Assets'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['assetId'],
          properties: {
            assetId: { type: 'string', description: 'UUID of the document asset' },
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
                  downloadUrl: { type: 'string' },
                  expiresInSeconds: { type: 'number' },
                  mimeType: { type: 'string' },
                  filename: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { assetId } = assetParamSchema.parse(request.params);
      const result = await getAssetDownloadUrl(assetId, request.user!);
      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // 4. Soft-delete Asset (Never immediately removes audit evidence)
  fastify.delete(
    '/assets/:assetId',
    {
      schema: {
        description: 'Soft-delete a document asset. Never deletes audit logs or historical transaction evidence.',
        tags: ['Assets'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['assetId'],
          properties: {
            assetId: { type: 'string', description: 'UUID of the document asset to soft-delete' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              assetId: { type: 'string' },
            },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { assetId } = assetParamSchema.parse(request.params);
      const result = await softDeleteAsset(assetId, request.user!);
      return reply.send({
        success: true,
        message: result.message,
        assetId: result.assetId,
      });
    }
  );
}
