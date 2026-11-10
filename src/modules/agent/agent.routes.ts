import { FastifyInstance } from 'fastify';
import { agentStatusUpdateSchema } from './agent.types.js';
import { claimNextJob, updateJobStatusByAgent } from './agent.service.js';
import { requirePrintAgentAuth } from '../../auth/agentAuth.js';

export async function agentRoutes(fastify: FastifyInstance) {
  // 1. Claim Job Polling: POST /v1/agent/jobs/claim
  fastify.post(
    '/agent/jobs/claim',
    {
      schema: {
        description: 'Local printer agent hardware daemon polls to claim eligible paid and approved print jobs.',
        tags: ['Printer Agent'],
        security: [{ agentSecretAuth: [] }],
        headers: {
          type: 'object',
          properties: {
            'x-agent-secret': { type: 'string', description: 'Shared secret authentication credential' },
            'x-printer-id': { type: 'string', description: 'Assigned hardware printer ID' },
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
                  job: {
                    type: ['object', 'null'],
                    properties: {
                      jobId: { type: 'string' },
                      shortCode: { type: 'string' },
                      dispatchId: { type: 'string' },
                      packageUrl: { type: 'string' },
                      packageUrlExpiresAt: { type: 'string' },
                      settings: {
                        type: 'object',
                        properties: {
                          copies: { type: 'integer' },
                          isColor: { type: 'boolean' },
                          isDuplex: { type: 'boolean' },
                          pageSize: { type: 'string' },
                          pageRange: { type: 'string' },
                          fitToPage: { type: 'boolean' },
                          orientation: { type: 'string' },
                        },
                      },
                      document: {
                        type: 'object',
                        properties: {
                          pageCount: { type: 'integer' },
                          checksumSha256: { type: 'string' },
                          mimeType: { type: 'string' },
                          originalFileName: { type: 'string' },
                        },
                      },
                    },
                  },
                  pollIntervalSeconds: { type: 'number' },
                  printer: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      status: { type: 'string' },
                      lastHeartbeatAt: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [requirePrintAgentAuth],
    },
    async (request, reply) => {
      const claimResult = await claimNextJob(request.agent!);
      return reply.send({
        success: true,
        data: claimResult,
      });
    }
  );

  // 2. Report Status: POST /v1/agent/jobs/:id/status
  fastify.post(
    '/agent/jobs/:id/status',
    {
      schema: {
        description: 'Agent reports live hardware status progression: claimed_by_printer, printing, completed, or failed.',
        tags: ['Printer Agent'],
        security: [{ agentSecretAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Print Job UUID' },
          },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['claimed_by_printer', 'printing', 'completed', 'failed'],
            },
            failureReason: { type: 'string' },
            metadata: { type: 'object' },
          },
        },
      },
      preHandler: [requirePrintAgentAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = agentStatusUpdateSchema.parse(request.body);
      const result = await updateJobStatusByAgent(id, parsed, request.agent!);

      return reply.send({
        success: true,
        data: result,
      });
    }
  );
}
