import { prisma } from '../../db/client.js';

export async function getPrinterById(printerId: string) {
  const printer = await prisma.printer.findUnique({
    where: { id: printerId },
    include: {
      capabilities: true,
    },
  });

  if (!printer) {
    const error = new Error(`Printer '${printerId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  return {
    id: printer.id,
    name: printer.name,
    location: printer.location,
    status: printer.status,
    lastHeartbeatAt: printer.lastHeartbeatAt?.toISOString() ?? null,
    capabilities: printer.capabilities
      ? {
          supportsColor: printer.capabilities.supportsColor,
          supportsMono: printer.capabilities.supportsMono,
          supportsDuplex: printer.capabilities.supportsDuplex,
          supportedPageSizes: printer.capabilities.supportedPageSizes as string[],
          maxDpi: printer.capabilities.maxDpi,
        }
      : null,
  };
}

export async function getPrinterCapabilities(printerId: string) {
  const capability = await prisma.printerCapability.findUnique({
    where: { printerId },
  });

  if (!capability) {
    // Check if printer exists at all
    const printer = await prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) {
      const error = new Error(`Printer '${printerId}' not found.`);
      (error as unknown as { statusCode: number }).statusCode = 404;
      throw error;
    }

    const error = new Error(`Capabilities not configured for printer '${printerId}'.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  return {
    printerId: capability.printerId,
    supportsColor: capability.supportsColor,
    supportsMono: capability.supportsMono,
    supportsDuplex: capability.supportsDuplex,
    supportedPageSizes: capability.supportedPageSizes as string[],
    maxDpi: capability.maxDpi,
  };
}

export async function listAllPrinters() {
  const printers = await prisma.printer.findMany({
    include: { capabilities: true },
    orderBy: { id: 'asc' },
  });

  return printers.map((p) => ({
    id: p.id,
    name: p.name,
    location: p.location,
    status: p.status,
    lastHeartbeatAt: p.lastHeartbeatAt?.toISOString() ?? null,
    capabilities: p.capabilities
      ? {
          supportsColor: p.capabilities.supportsColor,
          supportsMono: p.capabilities.supportsMono,
          supportsDuplex: p.capabilities.supportsDuplex,
          supportedPageSizes: p.capabilities.supportedPageSizes as string[],
          maxDpi: p.capabilities.maxDpi,
        }
      : null,
  }));
}
