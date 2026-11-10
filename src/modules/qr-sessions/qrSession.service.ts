import crypto from 'node:crypto';
import { prisma } from '../../db/client.js';
import { config } from '../../config/index.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { QrSessionResponse } from './qrSession.types.js';

export function signQrToken(sessionId: string, printerId: string, expiresAtMs: number): string {
  const data = `${sessionId}:${printerId}:${expiresAtMs}`;
  return crypto.createHmac('sha256', config.JWT_SECRET).update(data).digest('hex');
}

export function verifyQrSignature(sessionId: string, printerId: string, expiresAtMs: number, signature: string): boolean {
  const expected = signQrToken(sessionId, printerId, expiresAtMs);
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function createQrSession(params: {
  printerId: string;
  ipAddress?: string;
  userAgent?: string;
  userId?: string;
}): Promise<QrSessionResponse> {
  // 1. Verify printer exists and is operational
  const printer = await prisma.printer.findUnique({
    where: { id: params.printerId },
    include: { capabilities: true },
  });

  if (!printer) {
    const error = new Error(`Printer '${params.printerId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (printer.status === 'maintenance') {
    const error = new Error(`Printer '${params.printerId}' is currently under maintenance.`);
    (error as unknown as { statusCode: number }).statusCode = 503;
    throw error;
  }

  // 2. Generate session credentials
  const sessionId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const ttlMs = config.QR_SESSION_TTL_MINUTES * 60 * 1000;
  const expiresAtDate = new Date(Date.now() + ttlMs);
  const signature = signQrToken(sessionId, printer.id, expiresAtDate.getTime());

  // 3. Persist session
  const session = await prisma.qrSession.create({
    data: {
      id: sessionId,
      printerId: printer.id,
      token,
      tokenSignature: signature,
      expiresAt: expiresAtDate,
      status: 'active',
      userId: params.userId ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    },
  });

  // 4. Audit Log
  await recordAuditEvent({
    userId: params.userId,
    actorType: params.userId ? 'user' : 'system',
    action: 'QR_SESSION_CREATED',
    entityType: 'QrSession',
    entityId: session.id,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    metadata: {
      printerId: printer.id,
      expiresAt: expiresAtDate.toISOString(),
    },
  });

  // 5. Build QR Payload
  const qrPayload = JSON.stringify({
    sid: session.id,
    pid: printer.id,
    tok: token,
    sig: signature,
    exp: expiresAtDate.getTime(),
  });

  return {
    sessionId: session.id,
    printerId: printer.id,
    token,
    signature,
    expiresAt: expiresAtDate.toISOString(),
    ttlSeconds: config.QR_SESSION_TTL_MINUTES * 60,
    qrPayload,
    printer: {
      id: printer.id,
      name: printer.name,
      status: printer.status,
      location: printer.location,
    },
  };
}

export async function getValidQrSession(sessionId: string) {
  const session = await prisma.qrSession.findUnique({
    where: { id: sessionId },
    include: { printer: { include: { capabilities: true } } },
  });

  if (!session) return null;
  if (session.status !== 'active') return null;
  if (new Date() > session.expiresAt) {
    // Lazy expire
    await prisma.qrSession.update({
      where: { id: sessionId },
      data: { status: 'expired' },
    });
    return null;
  }

  return session;
}
