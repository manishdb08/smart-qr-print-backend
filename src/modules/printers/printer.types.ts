import { z } from 'zod';

export const printerParamSchema = z.object({
  printerId: z.string().min(1, 'printerId is required'),
});

export type PrinterParamInput = z.infer<typeof printerParamSchema>;

export interface PrinterCapabilityResponse {
  printerId: string;
  supportsColor: boolean;
  supportsMono: boolean;
  supportsDuplex: boolean;
  supportedPageSizes: string[];
  maxDpi: number;
}
