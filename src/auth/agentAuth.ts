import crypto from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/index.js';
import { prisma } from '../db/client.js';

export function timingSafeMatch(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Authentication hook specifically for Printer Agent clients polling or reporting job status.
 * Requires secret provided via 'x-agent-secret' header or Bearer token.
 */
export async function requirePrintAgentAuth(request: FastifyRequest, reply: FastifyReply) {
  const secretHeader = request.headers['x-agent-secret'] as string | undefined;
  const authHeader = request.headers.authorization;
  
  let incomingSecret: string | undefined = secretHeader;
  if (!incomingSecret && authHeader?.startsWith('Bearer ')) {
    incomingSecret = authHeader.substring(7).trim();
  }

  if (!incomingSecret) {
    return reply.status(401).send({
      success: false,
      error: {
        code: 'AGENT_UNAUTHORIZED',
        message: 'Printer agent authentication required. Provide x-agent-secret header.',
      },
    });
  }

  // Fast check: verify against global system shared secret or database agent
  const matchesGlobal = timingSafeMatch(incomingSecret, config.PRINT_AGENT_SHARED_SECRET);
  const hashedIncoming = hashSecret(incomingSecret);

  // Look up agent in database if available
  let agentRecord: { id: string; printerId: string; agentName: string; isBlocked: boolean } | null = null;
  try {
    const found = await prisma.printerAgent.findFirst({
      where: {
        secretHash: hashedIncoming,
      },
    });
    if (found) {
      agentRecord = {
        id: found.id,
        printerId: found.printerId,
        agentName: found.agentName,
        isBlocked: found.isBlocked,
      };
    }
  } catch {
    // Database might be unreachable or in test mock
  }

  if (!matchesGlobal && !agentRecord) {
    return reply.status(401).send({
      success: false,
      error: {
        code: 'AGENT_INVALID_CREDENTIALS',
        message: 'Invalid agent credentials or shared secret.',
      },
    });
  }

  if (agentRecord?.isBlocked) {
    return reply.status(403).send({
      success: false,
      error: {
        code: 'AGENT_BLOCKED',
        message: 'This printer agent has been suspended/blocked.',
      },
    });
  }

  const agentPrinterId = (request.headers['x-printer-id'] as string) || agentRecord?.printerId || 'default-printer';

  request.agent = {
    id: agentRecord?.id ?? 'global-agent',
    printerId: agentPrinterId,
    agentName: agentRecord?.agentName ?? 'Global Print Agent Service',
    role: 'print_agent',
  };
}
