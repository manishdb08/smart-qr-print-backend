import { z } from 'zod';

export const transformationActionSchema = z.enum([
  'crop',
  'rotate',
  'remove_pages',
  'reorder_pages',
  'compress',
  'grayscale',
  'basic_color_correction',
  'translate',
  'OCR',
  'summarize',
  'extract_print_settings',
  'enhance_image',
  'colorize_image',
]);

export type TransformationAction = z.infer<typeof transformationActionSchema>;

export const createTransformationSchema = z.object({
  action: transformationActionSchema,
  sourceVersionId: z.string().optional(), // defaults to latest approved or original v1
  inputParams: z.record(z.any()).default({}),
  userConfirmedOwnership: z.boolean({
    required_error: 'You must explicitly confirm you own or have permission to process this document.',
  }),
});

export type CreateTransformationInput = z.infer<typeof createTransformationSchema>;

export const rejectTransformationSchema = z.object({
  rejectionReason: z.string().optional(),
});

export type RejectTransformationInput = z.infer<typeof rejectTransformationSchema>;

export interface TransformationDetailResponse {
  id: string;
  assetId: string;
  sourceVersionId: string;
  targetVersionId?: string | null;
  action: string;
  status: string;
  aiProvider: string;
  userConfirmedOwnership: boolean;
  inputParams: unknown;
  resultMetadata?: unknown;
  previewUrl?: string;
  errorMessage?: string | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  updatedAt: string;
}
