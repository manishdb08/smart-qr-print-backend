import { z } from 'zod';

export const assetParamSchema = z.object({
  assetId: z.string().min(1, 'assetId is required'),
});

export type AssetParamInput = z.infer<typeof assetParamSchema>;

export interface AssetDetailResponse {
  id: string;
  userId: string;
  originalFileName: string;
  mimeType: string;
  fileSizeBytes?: number | null;
  pageCount?: number | null;
  checksumSha256?: string | null;
  width?: number | null;
  height?: number | null;
  status: string;
  isImmutableOriginal: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  previewUrl?: string;
  versionCount: number;
}

export interface AssetVersionItem {
  id: string;
  versionNumber: number;
  derivationType: string;
  operationType?: string | null;
  sourceVersionId?: string | null;
  fileSizeBytes: number;
  pageCount: number;
  width?: number | null;
  height?: number | null;
  checksumSha256: string;
  status: string;
  isApproved: boolean;
  createdById?: string | null;
  metadata?: unknown;
  previewUrl?: string;
  createdAt: string;
}

export interface AssetDownloadUrlResponse {
  downloadUrl: string;
  expiresInSeconds: number;
  mimeType: string;
  filename: string;
}
