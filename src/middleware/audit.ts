import { prisma } from '../db/client.js';

export type ActorType = 'user' | 'agent' | 'webhook' | 'system';

export interface AuditLogParams {
  userId?: string | null;
  actorType?: ActorType;
  action: string;
  entityType: string;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordAuditEvent(params: AuditLogParams): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        userId: params.userId ?? null,
        actorType: params.actorType ?? 'user',
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        metadata: params.metadata ? JSON.parse(JSON.stringify(params.metadata)) : undefined,
      },
    });
  } catch (err) {
    // Non-fatal logging error: structured log without crashing request
    console.error('⚠️ [Audit] Failed to record audit event to database:', {
      action: params.action,
      entityType: params.entityType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
