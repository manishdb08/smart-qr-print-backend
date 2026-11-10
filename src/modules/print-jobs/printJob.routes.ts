import { FastifyInstance } from 'fastify';
import { createPrintJobSchema } from './printJob.types.js';
import {
  createDraftPrintJob,
  calculateJobQuote,
  getPrintJobById,
  listPrintJobs,
  cancelPrintJob,
} from './printJob.service.js';
import { authenticateUser } from '../../auth/rbac.js';

export async function printJobRoutes(fastify: FastifyInstance) {
  // 1. Create Draft Print Job
  fastify.post(
    '/print-jobs',
    {
      schema: {
        description: 'Create a draft print job from an approved asset version.',
        tags: ['Print Jobs & Pricing'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['assetVersionId', 'printerId'],
          properties: {
            assetVersionId: { type: 'string', description: 'UUID of the asset version' },
            printerId: { type: 'string', description: 'Target printer ID (e.g. library-a4-01)' },
            copies: { type: 'integer', default: 1 },
            isColor: { type: 'boolean', default: false },
            isDuplex: { type: 'boolean', default: false },
            pageSize: { type: 'string', default: 'A4' },
            pageRange: { type: 'string', default: 'all' },
            fitToPage: { type: 'boolean', default: true },
            orientation: { type: 'string', enum: ['portrait', 'landscape'], default: 'portrait' },
            rawRequestText: { type: 'string' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const parsed = createPrintJobSchema.parse(request.body);
      const job = await createDraftPrintJob(parsed, request.user!);
      return reply.status(201).send({
        success: true,
        data: job,
      });
    }
  );

  // 2. Request Server-side Quote for Print Job
  fastify.post(
    '/print-jobs/:id/quote',
    {
      schema: {
        description: 'Calculate official server-side pricing quote (integer paise, capability verification, duplex discount, minimum order constraint).',
        tags: ['Print Jobs & Pricing'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Print job UUID' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const jobWithQuote = await calculateJobQuote(id, request.user!);
      return reply.send({
        success: true,
        data: jobWithQuote,
      });
    }
  );

  // 3. Get Print Job Details
  fastify.get(
    '/print-jobs/:id',
    {
      schema: {
        description: 'Get details, settings, quote, and live status of a print job.',
        tags: ['Print Jobs & Pricing'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Print job UUID' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = await getPrintJobById(id, request.user!);
      return reply.send({
        success: true,
        data: job,
      });
    }
  );

  // 4. List Print Jobs
  fastify.get(
    '/print-jobs',
    {
      schema: {
        description: 'List print jobs with optional filters (status, printerId). Customers only see their own jobs.',
        tags: ['Print Jobs & Pricing'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            printerId: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const query = request.query as { printerId?: string; status?: string };
      const jobs = await listPrintJobs(query, request.user!);
      return reply.send({
        success: true,
        data: jobs,
      });
    }
  );

  // 5. Cancel Print Job
  fastify.post(
    '/print-jobs/:id/cancel',
    {
      schema: {
        description: 'Cancel an unpaid draft or awaiting_payment print job.',
        tags: ['Print Jobs & Pricing'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Print job UUID' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const cancelled = await cancelPrintJob(id, request.user!);
      return reply.send({
        success: true,
        data: cancelled,
      });
    }
  );
}
