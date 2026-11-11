import { prisma } from '../../db/client.js';
import { getStorageProvider } from '../../storage/index.js';
import { assertResourceOwnership } from '../../auth/rbac.js';
import { AuthenticatedUser } from '../../types/index.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { AssetDetailResponse, AssetVersionItem, AssetDownloadUrlResponse } from './asset.types.js';

export async function getAssetById(assetId: string, currentUser: AuthenticatedUser): Promise<AssetDetailResponse> {
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
    include: {
      _count: {
        select: { versions: true },
      },
    },
  });

  if (!asset || asset.isDeleted) {
    const error = new Error(`Document asset '${assetId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  // RBAC ownership check: customer can only view own assets, admin can view all
  const isAuthorized = assertResourceOwnership(currentUser, asset.userId) || currentUser.role === 'admin' || currentUser.role === 'printer_operator';
  if (!isAuthorized) {
    const error = new Error('Access denied: You do not have permission to view this document asset.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  const storageProvider = getStorageProvider();
  let previewUrl: string | undefined;
  try {
    previewUrl = await storageProvider.createPresignedDownloadUrl(asset.storageKey, 900);
  } catch {
    // Non-fatal preview URL generation failure
  }

  return {
    id: asset.id,
    userId: asset.userId,
    originalFileName: asset.originalFileName,
    mimeType: asset.mimeType,
    fileSizeBytes: asset.fileSizeBytes,
    pageCount: asset.pageCount,
    checksumSha256: asset.checksumSha256,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    isImmutableOriginal: asset.isImmutableOriginal,
    isDeleted: asset.isDeleted,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    previewUrl,
    versionCount: asset._count?.versions ?? 0,
  };
}

export async function getAssetVersions(
  assetId: string,
  currentUser: AuthenticatedUser
): Promise<AssetVersionItem[]> {
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset || asset.isDeleted) {
    const error = new Error(`Document asset '${assetId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  const isAuthorized = assertResourceOwnership(currentUser, asset.userId) || currentUser.role === 'admin' || currentUser.role === 'printer_operator';
  if (!isAuthorized) {
    const error = new Error('Access denied: You do not have permission to view versions for this document asset.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  const versions = await prisma.assetVersion.findMany({
    where: { assetId },
    orderBy: { versionNumber: 'asc' },
  });

  const storageProvider = getStorageProvider();

  const results: AssetVersionItem[] = await Promise.all(
    versions.map(async (v) => {
      let previewUrl: string | undefined;
      try {
        previewUrl = await storageProvider.createPresignedDownloadUrl(v.storageKey, 900);
      } catch {
        // Non-fatal
      }

      return {
        id: v.id,
        versionNumber: v.versionNumber,
        derivationType: v.derivationType,
        operationType: v.operationType,
        sourceVersionId: v.sourceVersionId,
        fileSizeBytes: v.fileSizeBytes,
        pageCount: v.pageCount,
        width: v.width,
        height: v.height,
        checksumSha256: v.checksumSha256,
        status: v.status,
        isApproved: v.isApproved,
        createdById: v.createdById,
        metadata: v.metadata ?? undefined,
        previewUrl,
        createdAt: v.createdAt.toISOString(),
      };
    })
  );

  return results;
}

export async function getAssetDownloadUrl(
  assetId: string,
  currentUser: AuthenticatedUser
): Promise<AssetDownloadUrlResponse> {
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset || asset.isDeleted) {
    const error = new Error(`Document asset '${assetId}' not found.`);
    (error as any).statusCode = 404;
    throw error;
  }

  // Authorization check: Owner or Admin or Printer Operator
  const isAuthorized =
    assertResourceOwnership(currentUser, asset.userId) ||
    currentUser.role === 'admin' ||
    currentUser.role === 'printer_operator';

  if (!isAuthorized) {
    const error = new Error('Access denied: You do not have permission to download this asset.');
    (error as any).statusCode = 403;
    throw error;
  }

  if (asset.status !== 'ready') {
    const error = new Error(`Asset is not ready for download. Current status: ${asset.status}`);
    (error as any).statusCode = 400;
    throw error;
  }

  const storageProvider = getStorageProvider();
  const downloadUrl = await storageProvider.createPresignedDownloadUrl(asset.storageKey, 900);

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'DOWNLOAD_REQUESTED',
    entityType: 'DocumentAsset',
    entityId: assetId,
    metadata: {
      assetId,
      storageKey: asset.storageKey,
      mimeType: asset.mimeType,
      pageCount: asset.pageCount,
    },
  });

  return {
    downloadUrl,
    expiresInSeconds: 900,
    mimeType: asset.mimeType,
    filename: asset.originalFileName,
  };
}

export async function softDeleteAsset(
  assetId: string,
  currentUser: AuthenticatedUser
): Promise<{ success: boolean; message: string; assetId: string }> {
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset || asset.isDeleted) {
    const error = new Error(`Document asset '${assetId}' not found.`);
    (error as any).statusCode = 404;
    throw error;
  }

  // Authorization check: Owner or Admin only
  const isAuthorized = assertResourceOwnership(currentUser, asset.userId) || currentUser.role === 'admin';
  if (!isAuthorized) {
    const error = new Error('Access denied: You do not have permission to delete this asset.');
    (error as any).statusCode = 403;
    throw error;
  }

  // Soft delete only. Retains all versions and audit evidence intact
  await prisma.documentAsset.update({
    where: { id: assetId },
    data: {
      isDeleted: true,
      deletedAt: new Date(),
    },
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'DELETION_REQUESTED',
    entityType: 'DocumentAsset',
    entityId: assetId,
    metadata: {
      assetId,
      originalFileName: asset.originalFileName,
      softDeleted: true,
    },
  });

  return {
    success: true,
    message: 'Document asset soft-deleted successfully.',
    assetId,
  };
}
