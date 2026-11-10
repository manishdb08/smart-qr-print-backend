import { FastifyInstance } from 'fastify';
import { createQrSessionSchema } from './qrSession.types.js';
import { createQrSession } from './qrSession.service.js';
import { authenticateUser } from '../../auth/rbac.js';

export async function qrSessionRoutes(fastify: FastifyInstance) {
  // Public or optionally authenticated QR session creation
  fastify.post(
    '/qr-sessions',
    {
      schema: {
        description: 'Create a short-lived signed QR access session for a specific printer.',
        tags: ['QR & Auth'],
        body: {
          type: 'object',
          required: ['printerId'],
          properties: {
            printerId: { type: 'string', description: 'ID of the physical printer kiosk, e.g. library-a4-01' },
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
                  sessionId: { type: 'string' },
                  printerId: { type: 'string' },
                  token: { type: 'string' },
                  signature: { type: 'string' },
                  expiresAt: { type: 'string' },
                  ttlSeconds: { type: 'number' },
                  qrPayload: { type: 'string' },
                  printer: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      status: { type: 'string' },
                      location: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [authenticateUser(true)], // Optional user context if logged in
    },
    async (request, reply) => {
      const parsed = createQrSessionSchema.parse(request.body);
      const session = await createQrSession({
        printerId: parsed.printerId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        userId: request.user?.id,
      });

      return reply.status(201).send({
        success: true,
        data: session,
      });
    }
  );
}
