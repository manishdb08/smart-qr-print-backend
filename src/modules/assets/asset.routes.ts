import { FastifyInstance } from 'fastify';
import { assetParamSchema } from './asset.types.js';
import { getAssetById, getAssetVersions } from './asset.service.js';
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
                  isImmutableOriginal: { type: 'boolean' },
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
                    fileSizeBytes: { type: 'number' },
                    pageCount: { type: 'number' },
                    checksumSha256: { type: 'string' },
                    isApproved: { type: 'boolean' },
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
}
