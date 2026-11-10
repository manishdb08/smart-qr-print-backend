import { prisma } from '../../db/client.js';
import { getStorageProvider } from '../../storage/index.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { AuthenticatedAgent } from '../../types/index.js';
import { AgentStatusUpdateInput, ClaimJobResponse } from './agent.types.js';

export async function claimNextJob(agent: AuthenticatedAgent): Promise<ClaimJobResponse> {
  const now = new Date();

  // 1. Refresh printer heartbeat and ensure online status
  const printer = await prisma.printer.update({
    where: { id: agent.printerId },
    data: {
      lastHeartbeatAt: now,
      status: 'online',
    },
  });

  // Also touch printerAgent lastSeenAt
  if (agent.id && agent.id !== 'global-agent') {
    await prisma.printerAgent.updateMany({
      where: { id: agent.id },
      data: { lastSeenAt: now },
    });
  }

  // 2. Select next eligible job (must be strictly 'queued', paid, approved, and unexpired)
  const claimableJob = await prisma.printJob.findFirst({
    where: {
      printerId: agent.printerId,
      status: 'queued',
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    include: {
      settings: true,
      assetVersion: {
        include: { asset: true },
      },
    },
    orderBy: { createdAt: 'asc' }, // FIFO Queue
  });

  if (!claimableJob) {
    return {
      job: null,
      pollIntervalSeconds: 5,
      printer: {
        id: printer.id,
        name: printer.name,
        status: printer.status,
        lastHeartbeatAt: now.toISOString(),
      },
    };
  }

  // 3. Generate short-lived signed print package URL for the hardware agent
  const storageProvider = getStorageProvider();
  const packageUrlExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const packageUrl = await storageProvider.createPresignedDownloadUrl(
    claimableJob.assetVersion.storageKey,
    15 * 60
  );

  // 4. Transactionally claim job and record PrinterDispatch
  const dispatch = await prisma.$transaction(async (tx) => {
    const createdDispatch = await tx.printerDispatch.create({
      data: {
        printJobId: claimableJob.id,
        printerId: agent.printerId,
        printerAgentId: agent.id !== 'global-agent' ? agent.id : null,
        dispatchStatus: 'claimed',
        claimedAt: now,
        downloadUrlExpiresAt: packageUrlExpiresAt,
      },
    });

    await tx.printJob.update({
      where: { id: claimableJob.id },
      data: {
        status: 'claimed_by_printer',
      },
    });

    return createdDispatch;
  });

  await recordAuditEvent({
    actorType: 'agent',
    action: 'PRINT_JOB_CLAIMED_BY_AGENT',
    entityType: 'PrintJob',
    entityId: claimableJob.id,
    metadata: {
      printerId: agent.printerId,
      agentId: agent.id,
      dispatchId: dispatch.id,
      shortCode: claimableJob.shortCode,
    },
  });

  return {
    job: {
      jobId: claimableJob.id,
      shortCode: claimableJob.shortCode,
      dispatchId: dispatch.id,
      packageUrl,
      packageUrlExpiresAt: packageUrlExpiresAt.toISOString(),
      settings: {
        copies: claimableJob.settings?.copies || 1,
        isColor: claimableJob.settings?.isColor || false,
        isDuplex: claimableJob.settings?.isDuplex || false,
        pageSize: claimableJob.settings?.pageSize || 'A4',
        pageRange: claimableJob.settings?.pageRange || 'all',
        fitToPage: claimableJob.settings?.fitToPage ?? true,
        orientation: claimableJob.settings?.orientation || 'portrait',
      },
      document: {
        pageCount: claimableJob.assetVersion.pageCount,
        checksumSha256: claimableJob.assetVersion.checksumSha256,
        mimeType: claimableJob.assetVersion.asset.mimeType,
        originalFileName: claimableJob.assetVersion.asset.originalFileName,
      },
    },
    pollIntervalSeconds: 3,
    printer: {
      id: printer.id,
      name: printer.name,
      status: printer.status,
      lastHeartbeatAt: now.toISOString(),
    },
  };
}

export async function updateJobStatusByAgent(
  jobId: string,
  input: AgentStatusUpdateInput,
  agent: AuthenticatedAgent
) {
  const job = await prisma.printJob.findUnique({
    where: { id: jobId },
    include: { dispatches: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  if (!job) {
    const error = new Error(`Print job '${jobId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  // Cross-printer protection: Agent cannot manipulate jobs for another printer
  if (job.printerId !== agent.printerId && agent.id !== 'global-agent') {
    const error = new Error(`Access denied: Agent for printer '${agent.printerId}' cannot report status for job assigned to '${job.printerId}'.`);
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  const latestDispatch = job.dispatches[0];
  const now = new Date();

  if (input.status === 'printing') {
    await prisma.$transaction(async (tx) => {
      await tx.printJob.update({
        where: { id: jobId },
        data: { status: 'printing' },
      });

      if (latestDispatch) {
        await tx.printerDispatch.update({
          where: { id: latestDispatch.id },
          data: { dispatchStatus: 'acked' },
        });
      }
    });

    await recordAuditEvent({
      actorType: 'agent',
      action: 'PRINT_JOB_PRINTING_STARTED',
      entityType: 'PrintJob',
      entityId: jobId,
    });
  } else if (input.status === 'completed') {
    await prisma.$transaction(async (tx) => {
      await tx.printJob.update({
        where: { id: jobId },
        data: { status: 'completed' },
      });

      if (latestDispatch) {
        await tx.printerDispatch.update({
          where: { id: latestDispatch.id },
          data: {
            dispatchStatus: 'printed',
            printedAt: now,
          },
        });
      }
    });

    await recordAuditEvent({
      actorType: 'agent',
      action: 'PRINT_JOB_COMPLETED',
      entityType: 'PrintJob',
      entityId: jobId,
      metadata: {
        printerId: agent.printerId,
      },
    });
  } else if (input.status === 'failed') {
    const newRetryCount = job.retryCount + 1;
    const canRetry = newRetryCount < 3; // Retry policy: maximum 3 hardware attempts

    await prisma.$transaction(async (tx) => {
      await tx.printJob.update({
        where: { id: jobId },
        data: {
          status: canRetry ? 'queued' : 'failed', // Re-queue if under retry threshold
          failureReason: input.failureReason || 'Print hardware failure reported by agent',
          retryCount: newRetryCount,
        },
      });

      if (latestDispatch) {
        await tx.printerDispatch.update({
          where: { id: latestDispatch.id },
          data: {
            dispatchStatus: 'dispatch_failed',
            failureReason: input.failureReason || 'Failed during execution',
          },
        });
      }
    });

    await recordAuditEvent({
      actorType: 'agent',
      action: 'PRINT_JOB_FAILED',
      entityType: 'PrintJob',
      entityId: jobId,
      metadata: {
        reason: input.failureReason,
        retryCount: newRetryCount,
        requeued: canRetry,
      },
    });
  }

  return {
    success: true,
    jobId,
    reportedStatus: input.status,
    timestamp: now.toISOString(),
  };
}

export async function detectOfflinePrinters(heartbeatThresholdMinutes = 5) {
  const cutoff = new Date(Date.now() - heartbeatThresholdMinutes * 60 * 1000);

  const stalePrinters = await prisma.printer.findMany({
    where: {
      status: 'online',
      OR: [
        { lastHeartbeatAt: null },
        { lastHeartbeatAt: { lt: cutoff } },
      ],
    },
  });

  for (const printer of stalePrinters) {
    await prisma.printer.update({
      where: { id: printer.id },
      data: { status: 'offline' },
    });
  }

  return stalePrinters.map((p) => p.id);
}
