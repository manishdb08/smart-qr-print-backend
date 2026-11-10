import { FastifyInstance } from 'fastify';
import {
  createTransformationSchema,
  rejectTransformationSchema,
} from './transformation.types.js';
import {
  requestTransformation,
  getTransformationById,
  approveTransformation,
  rejectTransformation,
} from './transformation.service.js';
import { authenticateUser } from '../../auth/rbac.js';

export async function transformationRoutes(fastify: FastifyInstance) {
  // 1. Request Transformation
  fastify.post(
    '/assets/:assetId/transformations',
    {
      schema: {
        description:
          'Request an AI or deterministic transformation on a document asset (crop, rotate, translate, OCR, summarize, extract settings, enhance, etc.).',
        tags: ['AI & Transformations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['assetId'],
          properties: {
            assetId: { type: 'string', description: 'Unique UUID of the document asset' },
          },
        },
        body: {
          type: 'object',
          required: ['action', 'userConfirmedOwnership'],
          properties: {
            action: {
              type: 'string',
              enum: [
                'crop',
                'rotate',
                'remove_pages',
                'reorder_pages',
                'compress',
                'grayscale',
                'basic_color_correction',
                'translate',
                'OCR',
                'summarize',
                'extract_print_settings',
                'enhance_image',
                'colorize_image',
              ],
            },
            sourceVersionId: { type: 'string', description: 'Optional source version to transform from' },
            inputParams: { type: 'object', description: 'Parameters for the transformation' },
            userConfirmedOwnership: {
              type: 'boolean',
              description: 'User confirmation that they own or have permission to process this document',
            },
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
                  id: { type: 'string' },
                  assetId: { type: 'string' },
                  action: { type: 'string' },
                  status: { type: 'string' },
                  aiProvider: { type: 'string' },
                  previewUrl: { type: 'string' },
                  resultMetadata: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { assetId } = request.params as { assetId: string };
      const parsed = createTransformationSchema.parse(request.body);
      const result = await requestTransformation(assetId, parsed, request.user!);

      return reply.status(201).send({
        success: true,
        data: result,
      });
    }
  );

  // 2. Get Transformation Status & Preview
  fastify.get(
    '/transformations/:transformationId',
    {
      schema: {
        description: 'Get transformation status, AI output, and signed preview URL.',
        tags: ['AI & Transformations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['transformationId'],
          properties: {
            transformationId: { type: 'string', description: 'Unique UUID of the transformation' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { transformationId } = request.params as { transformationId: string };
      const result = await getTransformationById(transformationId, request.user!);
      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // 3. Approve Transformation (Creates derived AssetVersion)
  fastify.post(
    '/transformations/:transformationId/approve',
    {
      schema: {
        description: 'Approve preview transformation, promoting derived file to a new printable AssetVersion.',
        tags: ['AI & Transformations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['transformationId'],
          properties: {
            transformationId: { type: 'string', description: 'Unique UUID of the transformation' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { transformationId } = request.params as { transformationId: string };
      const result = await approveTransformation(transformationId, request.user!);
      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // 4. Reject Transformation
  fastify.post(
    '/transformations/:transformationId/reject',
    {
      schema: {
        description: 'Reject preview transformation with optional feedback or reason.',
        tags: ['AI & Transformations'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['transformationId'],
          properties: {
            transformationId: { type: 'string', description: 'Unique UUID of the transformation' },
          },
        },
        body: {
          type: 'object',
          properties: {
            rejectionReason: { type: 'string' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { transformationId } = request.params as { transformationId: string };
      const parsed = rejectTransformationSchema.parse(request.body || {});
      const result = await rejectTransformation(transformationId, parsed.rejectionReason, request.user!);
      return reply.send({
        success: true,
        data: result,
      });
    }
  );
}
