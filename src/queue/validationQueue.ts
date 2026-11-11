import crypto from 'node:crypto';
import path from 'node:path';
import { Queue, Worker, Job } from 'bullmq';
import { getRedisOptions } from './redis.js';
import { config } from '../config/index.js';
import { prisma } from '../db/client.js';
import { getStorageProvider } from '../storage/index.js';
import { validateAndInspectFile } from '../security/fileValidator.js';
import { getMalwareScanner } from '../security/malwareScanner.js';
import { recordAuditEvent } from '../middleware/audit.js';

export interface ValidationJobPayload {
  assetId: string;
  uploadSessionId?: string;
  userId: string;
}

let validationQueue: Queue<ValidationJobPayload> | null = null;
let validationWorker: Worker<ValidationJobPayload> | null = null;

export function getValidationQueue(): Queue<ValidationJobPayload> | null {
  if (config.NODE_ENV === 'test') {
    return null; // Direct in-process execution during tests
  }

  if (!validationQueue) {
    try {
      validationQueue = new Queue<ValidationJobPayload>('asset-validation', {
        connection: getRedisOptions(),
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1500,
          },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      });
    } catch {
      validationQueue = null;
    }
  }
  return validationQueue;
}

/**
 * Executes file inspection, magic byte verification, checksum calculation,
 * page/dimension extraction, malware scan, and updates asset status:
 * pending_upload -> uploaded -> validating -> ready (or rejected / malware_suspected).
 */
export async function executeAssetValidation(assetId: string, uploadSessionId?: string): Promise<{
  success: boolean;
  status: 'ready' | 'rejected' | 'malware_suspected';
  error?: string;
}> {
  // 1. Fetch asset
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset) {
    throw new Error(`Asset '${assetId}' not found for validation.`);
  }

  // 2. Transition status: validating
  await prisma.documentAsset.update({
    where: { id: assetId },
    data: { status: 'validating' },
  });

  const storageProvider = getStorageProvider();

  // 3. Download uploaded file from storage
  let buffer: Buffer;
  try {
    buffer = await storageProvider.getFileBuffer(asset.storageKey);
  } catch (storageErr) {
    const errorMsg = `Storage download failed for key '${asset.storageKey}': ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`;
    await prisma.documentAsset.update({
      where: { id: assetId },
      data: { status: 'rejected' },
    });
    await recordAuditEvent({
      userId: asset.userId,
      actorType: 'system',
      action: 'VALIDATION_FAILED',
      entityType: 'DocumentAsset',
      entityId: assetId,
      metadata: { reason: errorMsg },
    });
    return { success: false, status: 'rejected', error: errorMsg };
  }

  // 4. File inspection & validation (magic bytes, page count, corrupt file, encrypted PDF, dimensions)
  let validationResult;
  try {
    validationResult = await validateAndInspectFile(buffer, asset.originalFileName, asset.mimeType);
  } catch (validationErr) {
    const errorMsg = validationErr instanceof Error ? validationErr.message : String(validationErr);
    await prisma.documentAsset.update({
      where: { id: assetId },
      data: { status: 'rejected' },
    });
    await recordAuditEvent({
      userId: asset.userId,
      actorType: 'system',
      action: 'VALIDATION_FAILED',
      entityType: 'DocumentAsset',
      entityId: assetId,
      metadata: { reason: errorMsg, originalFileName: asset.originalFileName },
    });
    return { success: false, status: 'rejected', error: errorMsg };
  }

  // 5. Malware Scanner check
  const malwareScanner = getMalwareScanner();
  const scanResult = await malwareScanner.scanBuffer(buffer, asset.originalFileName);

  if (!scanResult.isClean) {
    // Quarantine by deleting from primary storage key
    try {
      await storageProvider.deleteFile(asset.storageKey);
    } catch {
      // Non-fatal
    }

    await prisma.documentAsset.update({
      where: { id: assetId },
      data: { status: 'malware_suspected' },
    });

    await recordAuditEvent({
      userId: asset.userId,
      actorType: 'system',
      action: 'VALIDATION_FAILED',
      entityType: 'DocumentAsset',
      entityId: assetId,
      metadata: {
        reason: 'Malware signature detected',
        threatName: scanResult.threatName,
        scanEngine: scanResult.scanEngine,
      },
    });

    return {
      success: false,
      status: 'malware_suspected',
      error: `Security alert: malware signature '${scanResult.threatName || 'Unknown'}' detected.`,
    };
  }

  // 6. Validation passed: promote asset to ready and create immutable Version 1
  await prisma.$transaction(async (tx) => {
    await tx.documentAsset.update({
      where: { id: assetId },
      data: {
        status: 'ready',
        mimeType: validationResult.actualMimeType,
        checksumSha256: validationResult.checksumSha256,
        fileSizeBytes: validationResult.fileSizeBytes,
        pageCount: validationResult.pageCount,
        width: validationResult.width ?? null,
        height: validationResult.height ?? null,
      },
    });

    // Check if Version 1 already exists (e.g. idempotency)
    const existingVersions = await tx.assetVersion.findMany({
      where: { assetId },
    });

    if (existingVersions.length === 0) {
      await tx.assetVersion.create({
        data: {
          assetId,
          versionNumber: 1,
          derivationType: 'original',
          operationType: 'upload',
          sourceVersionId: null,
          storageKey: asset.storageKey,
          checksumSha256: validationResult.checksumSha256,
          fileSizeBytes: validationResult.fileSizeBytes,
          pageCount: validationResult.pageCount,
          width: validationResult.width ?? null,
          height: validationResult.height ?? null,
          status: 'ready',
          isApproved: false,
          createdById: asset.userId,
          metadata: {
            ...validationResult.metadata,
            originalUpload: true,
            malwareScan: {
              clean: true,
              engine: scanResult.scanEngine,
              scannedAt: scanResult.scannedAt.toISOString(),
            },
          },
        },
      });
    }

    if (uploadSessionId) {
      await tx.uploadSession.update({
        where: { id: uploadSessionId },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });
    }
  });

  // 7. Audit log validation passed
  await recordAuditEvent({
    userId: asset.userId,
    actorType: 'system',
    action: 'VALIDATION_PASSED',
    entityType: 'DocumentAsset',
    entityId: assetId,
    metadata: {
      pageCount: validationResult.pageCount,
      checksumSha256: validationResult.checksumSha256,
      fileSizeBytes: validationResult.fileSizeBytes,
      mimeType: validationResult.actualMimeType,
    },
  });

  return { success: true, status: 'ready' };
}

/**
 * Dispatch validation to BullMQ queue or execute synchronously in test/dev
 */
export async function enqueueAssetValidation(payload: ValidationJobPayload): Promise<void> {
  const queue = getValidationQueue();
  if (queue) {
    await queue.add('validate-asset', payload, {
      jobId: `validate-${payload.assetId}`,
    });
  } else {
    // Immediate in-process execution
    await executeAssetValidation(payload.assetId, payload.uploadSessionId);
  }
}

export function startValidationWorker(): Worker<ValidationJobPayload> | null {
  if (config.NODE_ENV === 'test') {
    return null;
  }

  if (!validationWorker) {
    try {
      validationWorker = new Worker<ValidationJobPayload>(
        'asset-validation',
        async (job: Job<ValidationJobPayload>) => {
          await executeAssetValidation(job.data.assetId, job.data.uploadSessionId);
        },
        {
          connection: getRedisOptions(),
          concurrency: 4,
        }
      );

      validationWorker.on('failed', (job, err) => {
        console.error(`❌ Validation job ${job?.id} failed:`, err);
      });
    } catch (err) {
      console.warn('⚠️ BullMQ validation worker could not connect to Redis:', err);
      validationWorker = null;
    }
  }
  return validationWorker;
}
