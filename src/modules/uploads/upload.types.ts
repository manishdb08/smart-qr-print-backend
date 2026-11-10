import { z } from 'zod';

export const presignUploadSchema = z.object({
  originalFileName: z.string().min(1, 'originalFileName is required').max(255),
  mimeType: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
  fileSizeBytes: z.number().int().positive().max(50 * 1024 * 1024, 'Maximum file size is 50MB'),
  qrSessionToken: z.string().optional(),
});

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export const completeUploadSchema = z.object({
  storageKey: z.string().min(1, 'storageKey is required'),
  originalFileName: z.string().min(1, 'originalFileName is required'),
  mimeType: z.string().min(1, 'mimeType is required'),
  qrSessionToken: z.string().optional(),
});

export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

export interface PresignUploadResponse {
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
  maxSizeBytes: number;
  allowedMimeTypes: string[];
}

export interface CompleteUploadResponse {
  assetId: string;
  originalFileName: string;
  mimeType: string;
  pageCount: number;
  fileSizeBytes: number;
  checksumSha256: string;
  isImmutableOriginal: boolean;
  activeVersion: {
    id: string;
    versionNumber: number;
    derivationType: string;
    pageCount: number;
    fileSizeBytes: number;
    checksumSha256: string;
    previewUrl?: string;
  };
}
