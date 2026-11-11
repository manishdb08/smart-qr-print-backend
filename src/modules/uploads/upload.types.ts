import { z } from 'zod';

export const presignUploadSchema = z
  .object({
    filename: z.string().min(1, 'filename cannot be empty').max(255).optional(),
    originalFileName: z.string().min(1, 'originalFileName cannot be empty').max(255).optional(),
    declaredMimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']).optional(),
    mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']).optional(),
    sizeBytes: z.number().int().positive().max(25 * 1024 * 1024, 'Maximum file size is 25MB').optional(),
    fileSizeBytes: z.number().int().positive().max(25 * 1024 * 1024, 'Maximum file size is 25MB').optional(),
    qrSessionToken: z.string().optional(),
    idempotencyKey: z.string().optional(),
  })
  .refine((data) => data.filename || data.originalFileName, {
    message: 'Either filename or originalFileName is required',
    path: ['filename'],
  })
  .refine((data) => data.declaredMimeType || data.mimeType, {
    message: 'Either declaredMimeType or mimeType is required',
    path: ['declaredMimeType'],
  })
  .refine((data) => data.sizeBytes !== undefined || data.fileSizeBytes !== undefined, {
    message: 'Either sizeBytes or fileSizeBytes is required',
    path: ['sizeBytes'],
  });

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export const completeUploadParamSchema = z.object({
  uploadSessionId: z.string().min(1, 'uploadSessionId is required'),
});

export type CompleteUploadParams = z.infer<typeof completeUploadParamSchema>;

export const completeUploadBodySchema = z.object({
  uploadSessionId: z.string().optional(),
  storageKey: z.string().optional(),
  originalFileName: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  declaredMimeType: z.string().optional(),
  qrSessionToken: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export type CompleteUploadBody = z.infer<typeof completeUploadBodySchema>;

export interface PresignUploadResponse {
  uploadUrl: string;
  uploadSessionId: string;
  assetId: string;
  storageKey: string;
  expiresAt: string;
  maxSizeBytes: number;
  allowedMimeTypes: string[];
}

export interface CompleteUploadResponse {
  assetId: string;
  uploadSessionId?: string;
  status: string;
  originalFileName: string;
  mimeType: string;
  pageCount?: number;
  fileSizeBytes?: number;
  checksumSha256?: string;
  width?: number;
  height?: number;
  isImmutableOriginal: boolean;
  activeVersion?: {
    id: string;
    versionNumber: number;
    derivationType: string;
    pageCount: number;
    fileSizeBytes: number;
    checksumSha256: string;
    previewUrl?: string;
  };
}
