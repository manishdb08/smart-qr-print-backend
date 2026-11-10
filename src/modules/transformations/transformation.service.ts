import { prisma } from '../../db/client.js';
import { assertResourceOwnership } from '../../auth/rbac.js';
import { getStorageProvider } from '../../storage/index.js';
import { getTransformationQueue, executeTransformation } from '../../queue/transformationQueue.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { AuthenticatedUser } from '../../types/index.js';
import { config } from '../../config/index.js';
import { CreateTransformationInput, TransformationDetailResponse } from './transformation.types.js';

export async function requestTransformation(
  assetId: string,
  input: CreateTransformationInput,
  currentUser: AuthenticatedUser
): Promise<TransformationDetailResponse> {
  // 1. Mandatory ownership confirmation guardrail
  if (input.userConfirmedOwnership !== true) {
    const error = new Error('You must confirm you own or have legal authorization to process this document.');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // 2. Fetch document asset and verify ownership
  const asset = await prisma.documentAsset.findUnique({
    where: { id: assetId },
    include: {
      versions: {
        orderBy: { versionNumber: 'desc' },
      },
    },
  });

  if (!asset) {
    const error = new Error(`Document asset '${assetId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, asset.userId)) {
    const error = new Error('Access denied: You do not own this document asset.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  // 3. Determine source version
  let sourceVersion = asset.versions[0];
  if (input.sourceVersionId) {
    const found = asset.versions.find((v) => v.id === input.sourceVersionId);
    if (!found) {
      const error = new Error(`Source version '${input.sourceVersionId}' not found on asset.`);
      (error as unknown as { statusCode: number }).statusCode = 404;
      throw error;
    }
    sourceVersion = found;
  }

  // 4. Determine AI vs deterministic provider
  let aiProvider = 'deterministic';
  if (['summarize', 'translate', 'OCR', 'extract_print_settings'].includes(input.action)) {
    aiProvider = 'gemini';
  } else if (['enhance_image', 'colorize_image'].includes(input.action)) {
    aiProvider = 'sharp';
  }

  // 5. Persist transformation record
  const transformation = await prisma.aiTransformation.create({
    data: {
      assetId: asset.id,
      sourceVersionId: sourceVersion.id,
      action: input.action,
      status: 'pending',
      inputParams: input.inputParams || {},
      aiProvider,
      userConfirmedOwnership: input.userConfirmedOwnership,
    },
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'TRANSFORMATION_REQUESTED',
    entityType: 'AiTransformation',
    entityId: transformation.id,
    metadata: {
      assetId: asset.id,
      action: input.action,
      aiProvider,
    },
  });

  // 6. Asynchronous Queue Dispatch (or synchronous execution in test/direct fallback)
  const queue = getTransformationQueue();
  if (queue && config.NODE_ENV !== 'test') {
    await queue.add('process-transformation', {
      transformationId: transformation.id,
      assetId: asset.id,
      userId: currentUser.id,
    });
  } else {
    // Synchronous execution for tests or instant processing
    await executeTransformation(transformation.id);
  }

  return getTransformationById(transformation.id, currentUser);
}

export async function getTransformationById(
  transformationId: string,
  currentUser: AuthenticatedUser
): Promise<TransformationDetailResponse> {
  const transformation = await prisma.aiTransformation.findUnique({
    where: { id: transformationId },
    include: {
      asset: true,
      sourceVersion: true,
    },
  });

  if (!transformation) {
    const error = new Error(`Transformation '${transformationId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, transformation.asset.userId)) {
    const error = new Error('Access denied: You do not have permission to view this transformation.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  const resultMetadata = (transformation.resultMetadata as Record<string, any>) || {};
  let previewUrl: string | undefined;

  if (resultMetadata.previewStorageKey) {
    try {
      const storageProvider = getStorageProvider();
      previewUrl = await storageProvider.createPresignedDownloadUrl(resultMetadata.previewStorageKey, 900);
    } catch {
      // Non-fatal
    }
  }

  return {
    id: transformation.id,
    assetId: transformation.assetId,
    sourceVersionId: transformation.sourceVersionId,
    targetVersionId: transformation.targetVersionId,
    action: transformation.action,
    status: transformation.status,
    aiProvider: transformation.aiProvider,
    userConfirmedOwnership: transformation.userConfirmedOwnership,
    inputParams: transformation.inputParams,
    resultMetadata: transformation.resultMetadata ?? undefined,
    previewUrl,
    errorMessage: transformation.errorMessage,
    approvedAt: transformation.approvedAt?.toISOString() ?? null,
    rejectedAt: transformation.rejectedAt?.toISOString() ?? null,
    rejectionReason: transformation.rejectionReason,
    createdAt: transformation.createdAt.toISOString(),
    updatedAt: transformation.updatedAt.toISOString(),
  };
}

export async function approveTransformation(
  transformationId: string,
  currentUser: AuthenticatedUser
): Promise<{ transformation: TransformationDetailResponse; derivedVersion?: any }> {
  const transformation = await prisma.aiTransformation.findUnique({
    where: { id: transformationId },
    include: {
      asset: {
        include: {
          versions: {
            orderBy: { versionNumber: 'desc' },
          },
        },
      },
    },
  });

  if (!transformation) {
    const error = new Error(`Transformation '${transformationId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, transformation.asset.userId)) {
    const error = new Error('Access denied: You cannot approve this transformation.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  if (transformation.status !== 'completed') {
    const error = new Error(
      `Cannot approve transformation in '${transformation.status}' state. Only 'completed' transformations can be approved.`
    );
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  const resultMetadata = (transformation.resultMetadata as Record<string, any>) || {};
  let derivedVersion: any = null;

  // If transformation produced a derived asset file, promote it to a new immutable AssetVersion
  if (resultMetadata.previewStorageKey) {
    const highestVersionNum = transformation.asset.versions[0]?.versionNumber || 1;
    const newVersionNum = highestVersionNum + 1;

    derivedVersion = await prisma.assetVersion.create({
      data: {
        assetId: transformation.assetId,
        versionNumber: newVersionNum,
        derivationType: transformation.action,
        fileSizeBytes: resultMetadata.fileSizeBytes || 0,
        pageCount: resultMetadata.pageCount || 1,
        storageKey: resultMetadata.previewStorageKey,
        checksumSha256: resultMetadata.checksumSha256 || 'unknown',
        isApproved: true,
        metadata: {
          derivedFromVersionId: transformation.sourceVersionId,
          transformationId: transformation.id,
          action: transformation.action,
          aiProvider: transformation.aiProvider,
          ...resultMetadata,
        },
      },
    });

    await prisma.aiTransformation.update({
      where: { id: transformationId },
      data: {
        status: 'approved',
        approvedAt: new Date(),
        targetVersionId: derivedVersion.id,
      },
    });
  } else {
    // For text-only transformations (e.g. summarize, extract_print_settings)
    await prisma.aiTransformation.update({
      where: { id: transformationId },
      data: {
        status: 'approved',
        approvedAt: new Date(),
      },
    });
  }

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'TRANSFORMATION_APPROVED',
    entityType: 'AiTransformation',
    entityId: transformationId,
    metadata: {
      derivedVersionId: derivedVersion?.id,
      versionNumber: derivedVersion?.versionNumber,
    },
  });

  const updatedDetail = await getTransformationById(transformationId, currentUser);
  return {
    transformation: updatedDetail,
    derivedVersion,
  };
}

export async function rejectTransformation(
  transformationId: string,
  rejectionReason: string | undefined,
  currentUser: AuthenticatedUser
): Promise<TransformationDetailResponse> {
  const transformation = await prisma.aiTransformation.findUnique({
    where: { id: transformationId },
    include: { asset: true },
  });

  if (!transformation) {
    const error = new Error(`Transformation '${transformationId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, transformation.asset.userId)) {
    const error = new Error('Access denied: You cannot reject this transformation.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  if (transformation.status !== 'completed') {
    const error = new Error(
      `Cannot reject transformation in '${transformation.status}' state. Only 'completed' transformations can be rejected.`
    );
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  await prisma.aiTransformation.update({
    where: { id: transformationId },
    data: {
      status: 'rejected',
      rejectedAt: new Date(),
      rejectionReason: rejectionReason || 'User rejected transformation preview',
    },
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'TRANSFORMATION_REJECTED',
    entityType: 'AiTransformation',
    entityId: transformationId,
    metadata: {
      reason: rejectionReason,
    },
  });

  return getTransformationById(transformationId, currentUser);
}
