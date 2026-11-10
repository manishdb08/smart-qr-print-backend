import { prisma } from '../../db/client.js';
import { getStorageProvider } from '../../storage/index.js';
import { assertResourceOwnership } from '../../auth/rbac.js';
import { AuthenticatedUser } from '../../types/index.js';
import { AssetDetailResponse, AssetVersionItem } from './asset.types.js';

export async function getAssetById(assetId: string, currentUser: AuthenticatedUser): Promise<AssetDetailResponse> {
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
    include: {
      _count: {
        select: { versions: true },
      },
    },
  });

  if (!asset) {
    const error = new Error(`Document asset '${assetId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  // RBAC ownership check: customer can only view own assets, admin can view all
  const isAuthorized = assertResourceOwnership(currentUser, asset.userId);
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
    isImmutableOriginal: asset.isImmutableOriginal,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
    previewUrl,
    versionCount: asset._count.versions,
  };
}

export async function getAssetVersions(
  assetId: string,
  currentUser: AuthenticatedUser
): Promise<AssetVersionItem[]> {
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset) {
    const error = new Error(`Document asset '${assetId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  const isAuthorized = assertResourceOwnership(currentUser, asset.userId);
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
        fileSizeBytes: v.fileSizeBytes,
        pageCount: v.pageCount,
        checksumSha256: v.checksumSha256,
        isApproved: v.isApproved,
        metadata: v.metadata ?? undefined,
        previewUrl,
        createdAt: v.createdAt.toISOString(),
      };
    })
  );

  return results;
}
