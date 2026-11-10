import crypto from 'node:crypto';
import path from 'node:path';
import { Queue, Worker, Job } from 'bullmq';
import { getRedisOptions } from './redis.js';
import { config } from '../config/index.js';
import { prisma } from '../db/client.js';
import { getStorageProvider } from '../storage/index.js';
import { deterministicPdfProcessor } from '../processors/deterministicPdfProcessor.js';
import { deterministicImageProcessor } from '../processors/deterministicImageProcessor.js';
import { geminiAdapter } from '../ai/geminiAdapter.js';
import { imageAiAdapter } from '../ai/imageAiAdapter.js';
import { recordAuditEvent } from '../middleware/audit.js';

export interface TransformationJobPayload {
  transformationId: string;
  assetId: string;
  userId: string;
}

let transformationQueue: Queue<TransformationJobPayload> | null = null;
let transformationWorker: Worker<TransformationJobPayload> | null = null;

export function getTransformationQueue(): Queue<TransformationJobPayload> | null {
  if (config.NODE_ENV === 'test') {
    return null; // Bypass BullMQ in unit/integration tests for instant in-process execution
  }

  if (!transformationQueue) {
    transformationQueue = new Queue<TransformationJobPayload>('document-transformations', {
      connection: getRedisOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }
  return transformationQueue;
}

/**
 * Worker execution logic that runs both via BullMQ in production and in-process in dev/test.
 */
export async function executeTransformation(transformationId: string): Promise<void> {
  // 1. Fetch transformation details
  const transformation = await prisma.aiTransformation.findUnique({
    where: { id: transformationId },
    include: {
      asset: true,
      sourceVersion: true,
    },
  });

  if (!transformation) {
    throw new Error(`Transformation '${transformationId}' not found.`);
  }

  // Update status to processing
  await prisma.aiTransformation.update({
    where: { id: transformationId },
    data: { status: 'processing' },
  });

  const storageProvider = getStorageProvider();
  const sourceBuffer = await storageProvider.getFileBuffer(transformation.sourceVersion.storageKey);
  const action = transformation.action;
  const inputParams = (transformation.inputParams as Record<string, any>) || {};
  const mimeType = transformation.asset.mimeType;

  try {
    let resultBuffer: Buffer | null = null;
    let resultMetadata: Record<string, any> = {};
    let newPageCount = transformation.sourceVersion.pageCount;

    // ---------------------------------------------------------------------------
    // Deterministic PDF Processing
    // ---------------------------------------------------------------------------
    if (
      mimeType === 'application/pdf' &&
      ['crop', 'rotate', 'remove_pages', 'reorder_pages', 'compress', 'grayscale'].includes(action)
    ) {
      const res = await deterministicPdfProcessor.processPdf(sourceBuffer, action as any, inputParams);
      resultBuffer = res.buffer;
      resultMetadata = res.metadata;
      newPageCount = res.pageCount;
    }
    // ---------------------------------------------------------------------------
    // Deterministic Image Processing
    // ---------------------------------------------------------------------------
    else if (
      mimeType.startsWith('image/') &&
      ['crop', 'rotate', 'compress', 'grayscale', 'basic_color_correction'].includes(action)
    ) {
      const res = await deterministicImageProcessor.processImage(sourceBuffer, action as any, inputParams);
      resultBuffer = res.buffer;
      resultMetadata = res.metadata;
      newPageCount = 1;
    }
    // ---------------------------------------------------------------------------
    // AI Image Enhancement & Colorization
    // ---------------------------------------------------------------------------
    else if (action === 'enhance_image') {
      const res = await imageAiAdapter.enhanceImage(sourceBuffer, mimeType);
      resultBuffer = res.buffer;
      resultMetadata = res.metadata;
      newPageCount = 1;
    } else if (action === 'colorize_image') {
      const res = await imageAiAdapter.colorizeImage(sourceBuffer, mimeType);
      resultBuffer = res.buffer;
      resultMetadata = res.metadata;
      newPageCount = 1;
    }
    // ---------------------------------------------------------------------------
    // Gemini AI Text / Understanding / JSON Extraction
    // ---------------------------------------------------------------------------
    else if (action === 'summarize') {
      const summary = await geminiAdapter.summarize(sourceBuffer, mimeType);
      resultMetadata = { ...summary, aiProvider: 'gemini' };
    } else if (action === 'translate') {
      const targetLang = inputParams.targetLanguage || 'English';
      const translation = await geminiAdapter.translate(sourceBuffer, mimeType, targetLang);
      resultMetadata = { ...translation, aiProvider: 'gemini' };
    } else if (action === 'OCR') {
      const ocr = await geminiAdapter.performOcr(sourceBuffer, mimeType);
      resultMetadata = { ...ocr, aiProvider: 'gemini' };
    } else if (action === 'extract_print_settings') {
      const prompt = inputParams.prompt || '1 copy in black and white A4';
      const settings = await geminiAdapter.extractPrintSettings(prompt);
      resultMetadata = { extractedSettings: settings, aiProvider: 'gemini' };
    } else {
      throw new Error(`Unsupported action '${action}' for MIME type '${mimeType}'.`);
    }

    // If a derived file was generated, store it in object storage as a preview asset
    if (resultBuffer) {
      const ext = path.extname(transformation.sourceVersion.storageKey) || (mimeType === 'application/pdf' ? '.pdf' : '.png');
      const previewStorageKey = `derived/${transformation.assetId}/${transformation.id}/preview${ext}`;
      await storageProvider.putFileBuffer(previewStorageKey, resultBuffer, mimeType);

      const checksumSha256 = crypto.createHash('sha256').update(resultBuffer).digest('hex');
      resultMetadata.previewStorageKey = previewStorageKey;
      resultMetadata.fileSizeBytes = resultBuffer.length;
      resultMetadata.pageCount = newPageCount;
      resultMetadata.checksumSha256 = checksumSha256;
    }

    // Update transformation status to completed
    await prisma.aiTransformation.update({
      where: { id: transformationId },
      data: {
        status: 'completed',
        resultMetadata: resultMetadata,
      },
    });

    await recordAuditEvent({
      userId: transformation.asset.userId,
      actorType: 'system',
      action: 'TRANSFORMATION_COMPLETED',
      entityType: 'AiTransformation',
      entityId: transformationId,
      metadata: {
        action,
        assetId: transformation.assetId,
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await prisma.aiTransformation.update({
      where: { id: transformationId },
      data: {
        status: 'failed',
        errorMessage: errorMsg,
      },
    });

    await recordAuditEvent({
      userId: transformation.asset.userId,
      actorType: 'system',
      action: 'TRANSFORMATION_FAILED',
      entityType: 'AiTransformation',
      entityId: transformationId,
      metadata: {
        action,
        error: errorMsg,
      },
    });

    throw err;
  }
}

export function initTransformationWorker() {
  if (config.NODE_ENV === 'test') return null;

  if (!transformationWorker) {
    transformationWorker = new Worker<TransformationJobPayload>(
      'document-transformations',
      async (job: Job<TransformationJobPayload>) => {
        await executeTransformation(job.data.transformationId);
      },
      {
        connection: getRedisOptions(),
        concurrency: 5,
      }
    );

    transformationWorker.on('failed', (job, err) => {
      console.error(`❌ Transformation job ${job?.id} failed:`, err);
    });
  }
  return transformationWorker;
}
