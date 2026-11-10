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
  fileSizeBytes: number;
  pageCount: number;
  checksumSha256: string;
  isImmutableOriginal: boolean;
  createdAt: string;
  updatedAt: string;
  previewUrl?: string;
  versionCount: number;
}

export interface AssetVersionItem {
  id: string;
  versionNumber: number;
  derivationType: string;
  fileSizeBytes: number;
  pageCount: number;
  checksumSha256: string;
  isApproved: boolean;
  metadata?: unknown;
  previewUrl?: string;
  createdAt: string;
}
