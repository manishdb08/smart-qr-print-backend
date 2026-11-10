import { z } from 'zod';

export const createQrSessionSchema = z.object({
  printerId: z.string().min(1, 'printerId is required'),
});

export type CreateQrSessionInput = z.infer<typeof createQrSessionSchema>;

export interface QrSessionResponse {
  sessionId: string;
  printerId: string;
  token: string;
  signature: string;
  expiresAt: string;
  ttlSeconds: number;
  qrPayload: string;
  printer: {
    id: string;
    name: string;
    status: string;
    location: string;
  };
}
