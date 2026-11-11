import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from '../../db/client.js';
import { getStorageProvider } from '../../storage/index.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { config } from '../../config/index.js';
import { enqueueAssetValidation, executeAssetValidation } from '../../queue/validationQueue.js';
import { PresignUploadResponse, CompleteUploadResponse } from './upload.types.js';

export function sanitizeFileName(name: string): string {
  // Strip path traversal characters and directory segments
  const baseName = path.basename(name);
  return baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function createPresignedUpload(params: {
  userId: string;
  filename?: string;
  originalFileName?: string;
  declaredMimeType?: string;
  mimeType?: string;
  sizeBytes?: number;
  fileSizeBytes?: number;
  qrSessionToken?: string;
  idempotencyKey?: string;
}): Promise<PresignUploadResponse> {
  const rawFilename = params.filename || params.originalFileName;
  if (!rawFilename) {
    const error = new Error('Filename must be provided.');
    (error as any).statusCode = 400;
    throw error;
  }

  const effectiveMime = (params.declaredMimeType || params.mimeType || '').trim();
  const allowedList = config.ALLOWED_MIME_TYPES.split(',').map((s) => s.trim());
  if (!allowedList.includes(effectiveMime)) {
    const error = new Error(`Unsupported MIME type '${effectiveMime}'. Allowed types: ${allowedList.join(', ')}`);
    (error as any).statusCode = 400;
    throw error;
  }

  const effectiveSize = params.sizeBytes ?? params.fileSizeBytes ?? 0;
  if (effectiveSize > config.MAX_FILE_SIZE_BYTES) {
    const error = new Error(
      `File size (${effectiveSize} bytes) exceeds maximum allowable limit of ${config.MAX_FILE_SIZE_BYTES} bytes (25MB).`
    );
    (error as any).statusCode = 400;
    throw error;
  }

  // Idempotency check if idempotencyKey is provided
  if (params.idempotencyKey) {
    const existingSession = await prisma.uploadSession.findFirst({
      where: { idempotencyKey: params.idempotencyKey, userId: params.userId },
      include: { asset: true },
    });
    if (existingSession && existingSession.expiresAt > new Date()) {
      const storageProvider = getStorageProvider();
      const presigned = await storageProvider.createPresignedUploadUrl(existingSession.storageKey, existingSession.declaredMimeType, 900);
      return {
        uploadUrl: presigned.uploadUrl,
        uploadSessionId: existingSession.id,
        assetId: existingSession.assetId,
        storageKey: existingSession.storageKey,
        expiresAt: presigned.expiresAt.toISOString(),
        maxSizeBytes: config.MAX_FILE_SIZE_BYTES,
        allowedMimeTypes: allowedList,
      };
    }
  }

  const safeFilename = sanitizeFileName(rawFilename);
  const assetId = crypto.randomUUID();
  const uploadSessionId = crypto.randomUUID();
  // Store only generated object keys, never user-provided filesystem paths
  const storageKey = `uploads/${params.userId}/${assetId}/${safeFilename}`;

  const storageProvider = getStorageProvider();
  const presigned = await storageProvider.createPresignedUploadUrl(storageKey, effectiveMime, 900);

  await prisma.$transaction(async (tx) => {
    await tx.documentAsset.create({
      data: {
        id: assetId,
        userId: params.userId,
        originalFileName: safeFilename,
        mimeType: effectiveMime,
        storageKey,
        status: 'pending_upload',
        isImmutableOriginal: true,
        isDeleted: false,
      },
    });

    await tx.uploadSession.create({
      data: {
        id: uploadSessionId,
        assetId,
        userId: params.userId,
        storageKey,
        declaredMimeType: effectiveMime,
        sizeBytes: effectiveSize,
        status: 'pending',
        idempotencyKey: params.idempotencyKey ?? null,
        expiresAt: presigned.expiresAt,
      },
    });
  });

  await recordAuditEvent({
    userId: params.userId,
    actorType: 'user',
    action: 'UPLOAD_CREATED',
    entityType: 'DocumentAsset',
    entityId: assetId,
    metadata: {
      uploadSessionId,
      storageKey,
      declaredMimeType: effectiveMime,
      declaredSize: effectiveSize,
      qrSessionToken: params.qrSessionToken ? 'present' : undefined,
    },
  });

  return {
    uploadUrl: presigned.uploadUrl,
    uploadSessionId,
    assetId,
    storageKey,
    expiresAt: presigned.expiresAt.toISOString(),
    maxSizeBytes: config.MAX_FILE_SIZE_BYTES,
    allowedMimeTypes: allowedList,
  };
}

export async function completeUploadSession(params: {
  uploadSessionId: string;
  userId: string;
  idempotencyKey?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<CompleteUploadResponse> {
  const session = await prisma.uploadSession.findUnique({
    where: { id: params.uploadSessionId },
    include: { asset: true },
  });

  if (!session) {
    const error = new Error(`Upload session '${params.uploadSessionId}' not found.`);
    (error as any).statusCode = 404;
    throw error;
  }

  // Authorize by ownership
  if (session.userId !== params.userId) {
    const error = new Error('Access denied: Upload session does not belong to the authenticated user.');
    (error as any).statusCode = 403;
    throw error;
  }

  // Idempotency: If already completed or ready, return existing asset safely
  if (session.status === 'completed' || session.asset.status === 'ready') {
    const asset = await prisma.documentAsset.findUnique({
      where: { id: session.assetId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    const activeVersion = asset?.versions?.[0];
    let previewUrl: string | undefined;
    if (activeVersion) {
      try {
        previewUrl = await getStorageProvider().createPresignedDownloadUrl(activeVersion.storageKey, 900);
      } catch {
        // Non-fatal
      }
    }

    return {
      assetId: session.assetId,
      uploadSessionId: session.id,
      status: asset?.status || 'ready',
      originalFileName: session.asset.originalFileName,
      mimeType: asset?.mimeType || session.declaredMimeType,
      pageCount: asset?.pageCount ?? undefined,
      fileSizeBytes: asset?.fileSizeBytes ?? undefined,
      checksumSha256: asset?.checksumSha256 ?? undefined,
      isImmutableOriginal: session.asset.isImmutableOriginal,
      activeVersion: activeVersion
        ? {
            id: activeVersion.id,
            versionNumber: activeVersion.versionNumber,
            derivationType: activeVersion.derivationType,
            pageCount: activeVersion.pageCount,
            fileSizeBytes: activeVersion.fileSizeBytes,
            checksumSha256: activeVersion.checksumSha256,
            previewUrl,
          }
        : undefined,
    };
  }

  // Expiration check
  if (session.status === 'expired' || session.expiresAt < new Date()) {
    const error = new Error('Upload session has expired. Please initiate a new presigned upload.');
    (error as any).statusCode = 400;
    throw error;
  }

  // Transition asset to uploaded and session to completed
  await prisma.$transaction(async (tx) => {
    await tx.documentAsset.update({
      where: { id: session.assetId },
      data: { status: 'uploaded' },
    });

    await tx.uploadSession.update({
      where: { id: session.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
      },
    });
  });

  await recordAuditEvent({
    userId: params.userId,
    actorType: 'user',
    action: 'UPLOAD_COMPLETED',
    entityType: 'DocumentAsset',
    entityId: session.assetId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    metadata: {
      uploadSessionId: session.id,
      storageKey: session.storageKey,
    },
  });

  // Execute validation
  // In test mode or when immediate validation is needed, run directly
  const valResult = await executeAssetValidation(session.assetId, session.id);
  if (!valResult.success) {
    if (valResult.status === 'malware_suspected') {
      const err = new Error(valResult.error || 'Malware detected in uploaded file.');
      (err as any).statusCode = 422;
      throw err;
    }
    // Validation inspection error
    const err = new Error(valResult.error || 'Uploaded file validation failed.');
    if (valResult.error?.includes('magic bytes') || valResult.error?.includes('File format not recognized')) {
      (err as any).statusCode = 415;
    } else if (valResult.error?.includes('extension') || valResult.error?.includes('Extension mismatch')) {
      (err as any).statusCode = 400;
    } else {
      (err as any).statusCode = 422;
    }
    throw err;
  }

  const updatedAsset = await prisma.documentAsset.findUnique({
    where: { id: session.assetId },
    include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
  });

  const activeV = updatedAsset?.versions?.[0];
  let previewUrl: string | undefined;
  if (activeV) {
    try {
      previewUrl = await getStorageProvider().createPresignedDownloadUrl(activeV.storageKey, 900);
    } catch {
      // Non-fatal
    }
  }

  return {
    assetId: session.assetId,
    uploadSessionId: session.id,
    status: updatedAsset?.status || 'ready',
    originalFileName: updatedAsset?.originalFileName || session.asset.originalFileName,
    mimeType: updatedAsset?.mimeType || session.declaredMimeType,
    pageCount: updatedAsset?.pageCount ?? undefined,
    fileSizeBytes: updatedAsset?.fileSizeBytes ?? undefined,
    checksumSha256: updatedAsset?.checksumSha256 ?? undefined,
    width: updatedAsset?.width ?? undefined,
    height: updatedAsset?.height ?? undefined,
    isImmutableOriginal: updatedAsset?.isImmutableOriginal ?? true,
    activeVersion: activeV
      ? {
          id: activeV.id,
          versionNumber: activeV.versionNumber,
          derivationType: activeV.derivationType,
          pageCount: activeV.pageCount,
          fileSizeBytes: activeV.fileSizeBytes,
          checksumSha256: activeV.checksumSha256,
          previewUrl,
        }
      : undefined,
  };
}

/**
 * Backward compatibility handler for POST /v1/uploads/complete
 * Supports existing callers and tests that pass { storageKey, originalFileName, mimeType }
 */
export async function completeUpload(params: {
  userId: string;
  uploadSessionId?: string;
  storageKey?: string;
  originalFileName?: string;
  filename?: string;
  declaredMimeType?: string;
  mimeType?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<CompleteUploadResponse> {
  // If uploadSessionId is provided, delegate to completeUploadSession
  if (params.uploadSessionId) {
    return completeUploadSession({
      uploadSessionId: params.uploadSessionId,
      userId: params.userId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  const storageKey = params.storageKey;
  if (!storageKey) {
    const error = new Error('Either uploadSessionId or storageKey is required.');
    (error as any).statusCode = 400;
    throw error;
  }

  // 1. Verify storage key ownership prefix (prevent arbitrary key hijacking)
  const expectedPrefix = `uploads/${params.userId}/`;
  if (!storageKey.startsWith(expectedPrefix)) {
    const error = new Error('Access denied: Storage key does not belong to the authenticated user.');
    (error as any).statusCode = 403;
    throw error;
  }

  // 2. Look for an existing UploadSession by storageKey
  const existingSession = await prisma.uploadSession.findUnique({
    where: { storageKey },
    include: { asset: true },
  });

  if (existingSession) {
    return completeUploadSession({
      uploadSessionId: existingSession.id,
      userId: params.userId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }

  // 3. Fallback for tests/seeders that created file directly in storage without presign:
  // Create DocumentAsset and UploadSession on the fly, then validate
  const rawFilename = params.filename || params.originalFileName || path.basename(storageKey);
  const safeFilename = sanitizeFileName(rawFilename);
  const effectiveMime = params.declaredMimeType || params.mimeType || 'application/octet-stream';
  const assetId = crypto.randomUUID();
  const uploadSessionId = crypto.randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.documentAsset.create({
      data: {
        id: assetId,
        userId: params.userId,
        originalFileName: safeFilename,
        mimeType: effectiveMime,
        storageKey,
        status: 'pending_upload',
        isImmutableOriginal: true,
        isDeleted: false,
      },
    });

    await tx.uploadSession.create({
      data: {
        id: uploadSessionId,
        assetId,
        userId: params.userId,
        storageKey,
        declaredMimeType: effectiveMime,
        sizeBytes: 0,
        status: 'pending',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
  });

  return completeUploadSession({
    uploadSessionId,
    userId: params.userId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Schedule or run cleanup for abandoned/stale upload sessions
 */
export async function cleanupAbandonedUploadSessions(): Promise<{ expiredCount: number }> {
  const now = new Date();
  const staleSessions = await prisma.uploadSession.findMany({
    where: {
      status: 'pending',
      expiresAt: { lt: now },
    },
    include: { asset: true },
  });

  let expiredCount = 0;
  for (const session of staleSessions) {
    await prisma.$transaction(async (tx) => {
      await tx.uploadSession.update({
        where: { id: session.id },
        data: { status: 'expired' },
      });

      if (session.asset && session.asset.status === 'pending_upload') {
        await tx.documentAsset.update({
          where: { id: session.assetId },
          data: { status: 'rejected' },
        });
      }
    });

    await recordAuditEvent({
      userId: session.userId,
      actorType: 'system',
      action: 'UPLOAD_SESSION_EXPIRED',
      entityType: 'DocumentAsset',
      entityId: session.assetId,
      metadata: { uploadSessionId: session.id, storageKey: session.storageKey },
    });

    expiredCount++;
  }

  return { expiredCount };
}
