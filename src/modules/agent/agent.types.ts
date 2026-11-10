import { z } from 'zod';

export const agentStatusUpdateSchema = z.object({
  status: z.enum(['claimed_by_printer', 'printing', 'completed', 'failed']),
  failureReason: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

export type AgentStatusUpdateInput = z.infer<typeof agentStatusUpdateSchema>;

export interface ClaimJobResponse {
  job: {
    jobId: string;
    shortCode: string;
    dispatchId: string;
    packageUrl: string;
    packageUrlExpiresAt: string;
    settings: {
      copies: number;
      isColor: boolean;
      isDuplex: boolean;
      pageSize: string;
      pageRange: string;
      fitToPage: boolean;
      orientation: string;
    };
    document: {
      pageCount: number;
      checksumSha256: string;
      mimeType: string;
      originalFileName: string;
    };
  } | null;
  pollIntervalSeconds: number;
  printer: {
    id: string;
    name: string;
    status: string;
    lastHeartbeatAt: string;
  };
}
