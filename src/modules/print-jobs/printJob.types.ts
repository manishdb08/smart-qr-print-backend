import { z } from 'zod';

export const createPrintJobSchema = z.object({
  assetVersionId: z.string().min(1, 'assetVersionId is required'),
  printerId: z.string().min(1, 'printerId is required'),
  copies: z.number().int().min(1).max(50).default(1),
  isColor: z.boolean().default(false),
  isDuplex: z.boolean().default(false),
  pageSize: z.string().default('A4'),
  pageRange: z.string().default('all'),
  fitToPage: z.boolean().default(true),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  rawRequestText: z.string().optional(),
});

export type CreatePrintJobInput = z.infer<typeof createPrintJobSchema>;

export interface PrintJobDetailResponse {
  id: string;
  shortCode: string;
  userId: string;
  printerId: string;
  assetVersionId: string;
  status: string;
  totalAmountPaise: number | null;
  retryCount: number;
  failureReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  settings?: {
    copies: number;
    isColor: boolean;
    isDuplex: boolean;
    pageSize: string;
    pageRange: string;
    fitToPage: boolean;
    orientation: string;
  };
  quote?: {
    id: string;
    pricingRuleVersion: string;
    subtotalPaise: number;
    discountPaise: number;
    taxPaise: number;
    totalAmountPaise: number;
    currency: string;
    calculatedPages: number;
    copies: number;
  } | null;
  printer?: {
    id: string;
    name: string;
    location: string;
    status: string;
  };
  assetVersion?: {
    id: string;
    versionNumber: number;
    pageCount: number;
    fileSizeBytes: number;
    derivationType: string;
    previewUrl?: string;
  };
}
