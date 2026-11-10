import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from '../../db/client.js';
import { getStorageProvider } from '../../storage/index.js';
import { validateAndInspectFile } from '../../security/fileValidator.js';
import { getMalwareScanner } from '../../security/malwareScanner.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { config } from '../../config/index.js';
import { PresignUploadResponse, CompleteUploadResponse } from './upload.types.js';

export function sanitizeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function createPresignedUpload(params: {
  userId: string;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes: number;
  qrSessionToken?: string;
}): Promise<PresignUploadResponse> {
  const safeFilename = sanitizeFileName(params.originalFileName);
  const uploadId = crypto.randomUUID();
  const storageKey = `uploads/${params.userId}/${uploadId}/${safeFilename}`;

  const storageProvider = getStorageProvider();
  const presigned = await storageProvider.createPresignedUploadUrl(storageKey, params.mimeType, 900);

  await recordAuditEvent({
    userId: params.userId,
    actorType: 'user',
    action: 'UPLOAD_PRESIGNED',
    entityType: 'DocumentAsset',
    metadata: {
      storageKey,
      mimeType: params.mimeType,
      declaredSize: params.fileSizeBytes,
      qrSessionToken: params.qrSessionToken ? 'present' : undefined,
    },
  });

  return {
    uploadUrl: presigned.uploadUrl,
    storageKey,
    expiresAt: presigned.expiresAt.toISOString(),
    maxSizeBytes: config.MAX_FILE_SIZE_BYTES,
    allowedMimeTypes: config.ALLOWED_MIME_TYPES.split(',').map((s) => s.trim()),
  };
}

export async function completeUpload(params: {
  userId: string;
  storageKey: string;
  originalFileName: string;
  declaredMimeType: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<CompleteUploadResponse> {
  // 1. Verify storage key ownership prefix (prevent arbitrary key hijacking)
  const expectedPrefix = `uploads/${params.userId}/`;
  if (!params.storageKey.startsWith(expectedPrefix)) {
    const error = new Error('Access denied: Storage key does not belong to the authenticated user.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  // 2. Fetch file buffer from storage
  const storageProvider = getStorageProvider();
  let buffer: Buffer;
  try {
    buffer = await storageProvider.getFileBuffer(params.storageKey);
  } catch (err) {
    const error = new Error(
      `File not found in storage at key '${params.storageKey}'. Please ensure the upload completed successfully.`
    );
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // 3. Inspect magic bytes, checksum, true size, and true page count
  const validation = await validateAndInspectFile(buffer, params.originalFileName, params.declaredMimeType);

  // 4. Run Malware Scanner
  const malwareScanner = getMalwareScanner();
  const scanResult = await malwareScanner.scanBuffer(buffer, params.originalFileName);

  if (!scanResult.isClean) {
    // Quarantine/remove infected file from storage immediately
    try {
      await storageProvider.deleteFile(params.storageKey);
    } catch {
      // Ignore deletion failure on quarantine
    }

    await recordAuditEvent({
      userId: params.userId,
      actorType: 'user',
      action: 'MALWARE_DETECTED_UPLOAD_ABORTED',
      entityType: 'DocumentAsset',
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      metadata: {
        storageKey: params.storageKey,
        threatName: scanResult.threatName,
        scanEngine: scanResult.scanEngine,
      },
    });

    const error = new Error(
      `Security violation: File was rejected by malware scanning (${scanResult.threatName || 'Unknown Threat'}).`
    );
    (error as unknown as { statusCode: number }).statusCode = 422;
    throw error;
  }

  // 5. Atomic persistence: DocumentAsset and initial Version 1
  const safeFilename = sanitizeFileName(params.originalFileName);

  const result = await prisma.$transaction(async (tx) => {
    const asset = await tx.documentAsset.create({
      data: {
        userId: params.userId,
        originalFileName: safeFilename,
        mimeType: validation.actualMimeType,
        checksumSha256: validation.checksumSha256,
        fileSizeBytes: validation.fileSizeBytes,
        pageCount: validation.pageCount,
        storageKey: params.storageKey,
        isImmutableOriginal: true,
      },
    });

    const version1 = await tx.assetVersion.create({
      data: {
        assetId: asset.id,
        versionNumber: 1,
        derivationType: 'original',
        fileSizeBytes: validation.fileSizeBytes,
        pageCount: validation.pageCount,
        storageKey: params.storageKey,
        checksumSha256: validation.checksumSha256,
        isApproved: false,
        metadata: {
          ...validation.metadata,
          originalUpload: true,
          malwareScan: {
            clean: true,
            engine: scanResult.scanEngine,
            scannedAt: scanResult.scannedAt.toISOString(),
          },
        },
      },
    });

    return { asset, version1 };
  });

  // 6. Generate presigned preview download URL
  let previewUrl: string | undefined;
  try {
    previewUrl = await storageProvider.createPresignedDownloadUrl(params.storageKey, 900);
  } catch {
    // Non-fatal preview URL generation
  }

  // 7. Audit log
  await recordAuditEvent({
    userId: params.userId,
    actorType: 'user',
    action: 'ASSET_UPLOAD_COMPLETED',
    entityType: 'DocumentAsset',
    entityId: result.asset.id,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    metadata: {
      assetId: result.asset.id,
      versionId: result.version1.id,
      pageCount: result.asset.pageCount,
      checksumSha256: result.asset.checksumSha256,
    },
  });

  return {
    assetId: result.asset.id,
    originalFileName: result.asset.originalFileName,
    mimeType: result.asset.mimeType,
    pageCount: result.asset.pageCount,
    fileSizeBytes: result.asset.fileSizeBytes,
    checksumSha256: result.asset.checksumSha256,
    isImmutableOriginal: result.asset.isImmutableOriginal,
    activeVersion: {
      id: result.version1.id,
      versionNumber: result.version1.versionNumber,
      derivationType: result.version1.derivationType,
      pageCount: result.version1.pageCount,
      fileSizeBytes: result.version1.fileSizeBytes,
      checksumSha256: result.version1.checksumSha256,
      previewUrl,
    },
  };
}
