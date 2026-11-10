import crypto from 'node:crypto';
import { prisma } from '../../db/client.js';
import { assertResourceOwnership } from '../../auth/rbac.js';
import { calculatePriceQuote } from '../pricing/pricingEngine.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { getStorageProvider } from '../../storage/index.js';
import { AuthenticatedUser } from '../../types/index.js';
import { CreatePrintJobInput, PrintJobDetailResponse } from './printJob.types.js';

export function generateKioskShortCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
    if (i === 2) code += '-';
  }
  return code;
}

export async function createDraftPrintJob(
  input: CreatePrintJobInput,
  currentUser: AuthenticatedUser
): Promise<PrintJobDetailResponse> {
  // 1. Verify printer exists and is operational
  const printer = await prisma.printer.findUnique({
    where: { id: input.printerId },
    include: { capabilities: true },
  });

  if (!printer) {
    const error = new Error(`Printer '${input.printerId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (printer.status === 'offline' || printer.status === 'maintenance') {
    const error = new Error(`Printer '${printer.name}' is currently ${printer.status}. Please select another printer.`);
    (error as unknown as { statusCode: number }).statusCode = 503;
    throw error;
  }

  // 2. Verify asset version exists and belongs to user
  const assetVersion = await prisma.assetVersion.findUnique({
    where: { id: input.assetVersionId },
    include: { asset: true },
  });

  if (!assetVersion) {
    const error = new Error(`Asset version '${input.assetVersionId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, assetVersion.asset.userId)) {
    const error = new Error('Access denied: You do not have permission to print this asset version.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  // 3. Create Draft PrintJob + PrintSettings
  const shortCode = generateKioskShortCode();

  const printJob = await prisma.$transaction(async (tx) => {
    const job = await tx.printJob.create({
      data: {
        shortCode,
        userId: currentUser.id,
        printerId: printer.id,
        assetVersionId: assetVersion.id,
        status: 'draft',
      },
    });

    await tx.printSettings.create({
      data: {
        printJobId: job.id,
        copies: input.copies,
        isColor: input.isColor,
        isDuplex: input.isDuplex,
        pageSize: input.pageSize,
        pageRange: input.pageRange,
        fitToPage: input.fitToPage,
        orientation: input.orientation,
        rawRequestText: input.rawRequestText,
      },
    });

    return job;
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'PRINT_JOB_DRAFT_CREATED',
    entityType: 'PrintJob',
    entityId: printJob.id,
    metadata: {
      printerId: printer.id,
      shortCode,
    },
  });

  return getPrintJobById(printJob.id, currentUser);
}

export async function calculateJobQuote(
  printJobId: string,
  currentUser: AuthenticatedUser
): Promise<PrintJobDetailResponse> {
  const job = await prisma.printJob.findUnique({
    where: { id: printJobId },
    include: {
      settings: true,
      printer: { include: { capabilities: true } },
      assetVersion: true,
    },
  });

  if (!job) {
    const error = new Error(`Print job '${printJobId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, job.userId)) {
    const error = new Error('Access denied: You do not have permission to quote this print job.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  if (!job.settings || !job.printer?.capabilities) {
    const error = new Error('Incomplete print job configuration or missing printer capabilities.');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // Calculate pricing strictly via pricing engine (integer paise, hardware capability validation)
  const quoteResult = calculatePriceQuote({
    pageCount: job.assetVersion.pageCount,
    copies: job.settings.copies,
    isColor: job.settings.isColor,
    isDuplex: job.settings.isDuplex,
    pageSize: job.settings.pageSize,
    pageRange: job.settings.pageRange,
    printerCapabilities: {
      supportsColor: job.printer.capabilities.supportsColor,
      supportsMono: job.printer.capabilities.supportsMono,
      supportsDuplex: job.printer.capabilities.supportsDuplex,
      supportedPageSizes: job.printer.capabilities.supportedPageSizes as string[],
      maxDpi: job.printer.capabilities.maxDpi,
    },
  });

  const quoteExpiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30-minute validity

  // Persist PriceQuote and update job
  await prisma.$transaction(async (tx) => {
    const createdQuote = await tx.priceQuote.create({
      data: {
        printJobId: job.id,
        pricingRuleVersion: quoteResult.pricingRuleVersion,
        baseMonoPagePaise: quoteResult.baseMonoPagePaise,
        baseColorPagePaise: quoteResult.baseColorPagePaise,
        duplexDiscountPercent: quoteResult.duplexDiscountPercent,
        minOrderPaise: quoteResult.minOrderPaise,
        calculatedPages: quoteResult.calculatedPages,
        copies: quoteResult.copies,
        subtotalPaise: quoteResult.subtotalPaise,
        discountPaise: quoteResult.discountPaise,
        taxPaise: quoteResult.taxPaise,
        totalAmountPaise: quoteResult.totalAmountPaise,
        currency: quoteResult.currency,
        expiresAt: quoteExpiresAt,
      },
    });

    await tx.printJob.update({
      where: { id: job.id },
      data: {
        status: 'awaiting_payment',
        totalAmountPaise: quoteResult.totalAmountPaise,
      },
    });

    return createdQuote;
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'PRINT_JOB_QUOTED',
    entityType: 'PrintJob',
    entityId: job.id,
    metadata: {
      totalAmountPaise: quoteResult.totalAmountPaise,
      calculatedPages: quoteResult.calculatedPages,
      copies: quoteResult.copies,
      pricingRuleVersion: quoteResult.pricingRuleVersion,
    },
  });

  return getPrintJobById(job.id, currentUser);
}

export async function getPrintJobById(
  jobId: string,
  currentUser: AuthenticatedUser
): Promise<PrintJobDetailResponse> {
  const job = await prisma.printJob.findUnique({
    where: { id: jobId },
    include: {
      settings: true,
      printer: true,
      assetVersion: true,
      priceQuotes: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!job) {
    const error = new Error(`Print job '${jobId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  // Permission check: customer sees own jobs; operator sees assigned printer; admin sees all
  const isOwner = currentUser.role === 'admin' || job.userId === currentUser.id;
  const isAssignedOperator = currentUser.role === 'printer_operator';

  if (!isOwner && !isAssignedOperator) {
    const error = new Error('Access denied: You do not have permission to view this print job.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  const latestQuote = job.priceQuotes[0];
  let previewUrl: string | undefined;

  try {
    const storageProvider = getStorageProvider();
    previewUrl = await storageProvider.createPresignedDownloadUrl(job.assetVersion.storageKey, 900);
  } catch {
    // Non-fatal
  }

  return {
    id: job.id,
    shortCode: job.shortCode,
    userId: job.userId,
    printerId: job.printerId,
    assetVersionId: job.assetVersionId,
    status: job.status,
    totalAmountPaise: job.totalAmountPaise,
    retryCount: job.retryCount,
    failureReason: job.failureReason,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    settings: job.settings
      ? {
          copies: job.settings.copies,
          isColor: job.settings.isColor,
          isDuplex: job.settings.isDuplex,
          pageSize: job.settings.pageSize,
          pageRange: job.settings.pageRange,
          fitToPage: job.settings.fitToPage,
          orientation: job.settings.orientation,
        }
      : undefined,
    quote: latestQuote
      ? {
          id: latestQuote.id,
          pricingRuleVersion: latestQuote.pricingRuleVersion,
          subtotalPaise: latestQuote.subtotalPaise,
          discountPaise: latestQuote.discountPaise,
          taxPaise: latestQuote.taxPaise,
          totalAmountPaise: latestQuote.totalAmountPaise,
          currency: latestQuote.currency,
          calculatedPages: latestQuote.calculatedPages,
          copies: latestQuote.copies,
        }
      : null,
    printer: job.printer
      ? {
          id: job.printer.id,
          name: job.printer.name,
          location: job.printer.location,
          status: job.printer.status,
        }
      : undefined,
    assetVersion: job.assetVersion
      ? {
          id: job.assetVersion.id,
          versionNumber: job.assetVersion.versionNumber,
          pageCount: job.assetVersion.pageCount,
          fileSizeBytes: job.assetVersion.fileSizeBytes,
          derivationType: job.assetVersion.derivationType,
          previewUrl,
        }
      : undefined,
  };
}

export async function listPrintJobs(
  filter: { printerId?: string; status?: string },
  currentUser: AuthenticatedUser
): Promise<PrintJobDetailResponse[]> {
  const whereClause: any = {};

  if (currentUser.role === 'customer') {
    whereClause.userId = currentUser.id;
  }
  if (filter.printerId) {
    whereClause.printerId = filter.printerId;
  }
  if (filter.status) {
    whereClause.status = filter.status;
  }

  const jobs = await prisma.printJob.findMany({
    where: whereClause,
    include: {
      settings: true,
      printer: true,
      assetVersion: true,
      priceQuotes: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return Promise.all(jobs.map(async (job) => {
    const latestQuote = job.priceQuotes[0];
    return {
      id: job.id,
      shortCode: job.shortCode,
      userId: job.userId,
      printerId: job.printerId,
      assetVersionId: job.assetVersionId,
      status: job.status,
      totalAmountPaise: job.totalAmountPaise,
      retryCount: job.retryCount,
      failureReason: job.failureReason,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      settings: job.settings
        ? {
            copies: job.settings.copies,
            isColor: job.settings.isColor,
            isDuplex: job.settings.isDuplex,
            pageSize: job.settings.pageSize,
            pageRange: job.settings.pageRange,
            fitToPage: job.settings.fitToPage,
            orientation: job.settings.orientation,
          }
        : undefined,
      quote: latestQuote
        ? {
            id: latestQuote.id,
            pricingRuleVersion: latestQuote.pricingRuleVersion,
            subtotalPaise: latestQuote.subtotalPaise,
            discountPaise: latestQuote.discountPaise,
            taxPaise: latestQuote.taxPaise,
            totalAmountPaise: latestQuote.totalAmountPaise,
            currency: latestQuote.currency,
            calculatedPages: latestQuote.calculatedPages,
            copies: latestQuote.copies,
          }
        : null,
      printer: job.printer
        ? {
            id: job.printer.id,
            name: job.printer.name,
            location: job.printer.location,
            status: job.printer.status,
          }
        : undefined,
    };
  }));
}

export async function cancelPrintJob(
  jobId: string,
  currentUser: AuthenticatedUser
): Promise<PrintJobDetailResponse> {
  const job = await prisma.printJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    const error = new Error(`Print job '${jobId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, job.userId)) {
    const error = new Error('Access denied: You cannot cancel this print job.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  if (['printing', 'completed', 'claimed_by_printer', 'refunded'].includes(job.status)) {
    const error = new Error(`Cannot cancel print job in '${job.status}' status.`);
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  await prisma.printJob.update({
    where: { id: jobId },
    data: { status: 'cancelled' },
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'PRINT_JOB_CANCELLED',
    entityType: 'PrintJob',
    entityId: jobId,
  });

  return getPrintJobById(jobId, currentUser);
}
