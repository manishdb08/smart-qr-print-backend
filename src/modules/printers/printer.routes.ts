import { FastifyInstance } from 'fastify';
import { printerParamSchema } from './printer.types.js';
import { getPrinterById, getPrinterCapabilities, listAllPrinters } from './printer.service.js';

export async function printerRoutes(fastify: FastifyInstance) {
  // List all printers
  fastify.get(
    '/printers',
    {
      schema: {
        description: 'List all registered printers and operational status.',
        tags: ['Printers'],
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
                    name: { type: 'string' },
                    location: { type: 'string' },
                    status: { type: 'string' },
                    lastHeartbeatAt: { type: ['string', 'null'] },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const printers = await listAllPrinters();
      return reply.send({
        success: true,
        data: printers,
      });
    }
  );

  // Get specific printer by ID
  fastify.get(
    '/printers/:printerId',
    {
      schema: {
        description: 'Get details and live operational status of a specific printer.',
        tags: ['Printers'],
        params: {
          type: 'object',
          required: ['printerId'],
          properties: {
            printerId: { type: 'string', description: 'Unique identifier of the printer' },
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
                  name: { type: 'string' },
                  location: { type: 'string' },
                  status: { type: 'string' },
                  lastHeartbeatAt: { type: ['string', 'null'] },
                  capabilities: {
                    type: ['object', 'null'],
                    properties: {
                      supportsColor: { type: 'boolean' },
                      supportsMono: { type: 'boolean' },
                      supportsDuplex: { type: 'boolean' },
                      supportedPageSizes: { type: 'array', items: { type: 'string' } },
                      maxDpi: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { printerId } = printerParamSchema.parse(request.params);
      const printer = await getPrinterById(printerId);
      return reply.send({
        success: true,
        data: printer,
      });
    }
  );

  // Get printer capabilities
  fastify.get(
    '/printers/:printerId/capabilities',
    {
      schema: {
        description: 'Get hardware capabilities (color, duplex, supported paper sizes, DPI) of a specific printer.',
        tags: ['Printers'],
        params: {
          type: 'object',
          required: ['printerId'],
          properties: {
            printerId: { type: 'string', description: 'Unique identifier of the printer' },
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
                  printerId: { type: 'string' },
                  supportsColor: { type: 'boolean' },
                  supportsMono: { type: 'boolean' },
                  supportsDuplex: { type: 'boolean' },
                  supportedPageSizes: { type: 'array', items: { type: 'string' } },
                  maxDpi: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { printerId } = printerParamSchema.parse(request.params);
      const capabilities = await getPrinterCapabilities(printerId);
      return reply.send({
        success: true,
        data: capabilities,
      });
    }
  );
}
