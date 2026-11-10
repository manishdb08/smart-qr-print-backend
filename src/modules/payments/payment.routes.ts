import { FastifyInstance } from 'fastify';
import {
  createRazorpayOrderSchema,
  verifyPaymentSchema,
  refundRequestSchema,
} from './payment.types.js';
import {
  createPaymentOrder,
  verifyPayment,
  handleWebhookEvent,
  requestJobRefund,
} from './payment.service.js';
import { authenticateUser } from '../../auth/rbac.js';

export async function paymentRoutes(fastify: FastifyInstance) {
  // 1. Create Razorpay Order from Quote
  fastify.post(
    '/payments/razorpay/orders',
    {
      schema: {
        description: 'Create a Razorpay order from the server-side quote. Never trusts client-supplied prices.',
        tags: ['Payments & Razorpay'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['printJobId'],
          properties: {
            printJobId: { type: 'string', description: 'Print Job UUID' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const parsed = createRazorpayOrderSchema.parse(request.body);
      const order = await createPaymentOrder(parsed.printJobId, request.user!);
      return reply.send({
        success: true,
        data: order,
      });
    }
  );

  // 2. Verify Razorpay Payment (Client Callback)
  fastify.post(
    '/payments/razorpay/verify',
    {
      schema: {
        description: 'Verify payment signature using server-side HMAC. Transitions print job to queued upon success.',
        tags: ['Payments & Razorpay'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['printJobId', 'razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
          properties: {
            printJobId: { type: 'string' },
            razorpay_order_id: { type: 'string' },
            razorpay_payment_id: { type: 'string' },
            razorpay_signature: { type: 'string' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const parsed = verifyPaymentSchema.parse(request.body);
      const result = await verifyPayment(parsed, request.user!);
      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // 3. Webhook: POST /v1/webhooks/razorpay
  fastify.post(
    '/webhooks/razorpay',
    {
      schema: {
        description: 'Razorpay webhook receiver with constant-time HMAC signature verification and idempotent deduplication.',
        tags: ['Payments & Razorpay'],
      },
    },
    async (request, reply) => {
      const signatureHeader = (request.headers['x-razorpay-signature'] as string) || '';
      
      // Use raw body if preserved, or serialize parsed body
      const rawBody = (request as any).rawBody || JSON.stringify(request.body);
      const result = await handleWebhookEvent(rawBody, signatureHeader, request.body);

      return reply.send(result);
    }
  );

  // 4. Request Refund
  fastify.post(
    '/payments/:jobId/refund',
    {
      schema: {
        description: 'Request a refund for a paid print job.',
        tags: ['Payments & Razorpay'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['jobId'],
          properties: {
            jobId: { type: 'string', description: 'Print Job UUID' },
          },
        },
        body: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
        },
      },
      preHandler: [authenticateUser(false)],
    },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const parsed = refundRequestSchema.parse(request.body || {});
      const result = await requestJobRefund(jobId, parsed.reason, request.user!);
      return reply.send({
        success: true,
        data: result,
      });
    }
  );
}
