import { FastifyRequest, FastifyReply } from 'fastify';
import { UserRole, AuthenticatedUser } from '../types/index.js';
import { verifyUserToken } from './supabase.js';

export function authenticateUser(optional = false) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (optional) return;
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header. Expected Bearer token.',
        },
      });
    }

    const token = authHeader.substring(7).trim();
    const user = await verifyUserToken(token);

    if (!user) {
      if (optional) return;
      return reply.status(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid, revoked, or expired authentication token.',
        },
      });
    }

    request.user = user;
  };
}

export function requireRole(allowedRoles: UserRole[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // Run authentication first if not already done
    if (!request.user) {
      await authenticateUser(false)(request, reply);
      if (reply.sent) return;
    }

    const user = request.user;
    if (!user || !allowedRoles.includes(user.role)) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Access denied. Requires one of roles: [${allowedRoles.join(', ')}]. Current role: ${user?.role ?? 'anonymous'}`,
        },
      });
    }
  };
}

export function assertResourceOwnership(currentUser: AuthenticatedUser, resourceOwnerUserId: string): boolean {
  if (currentUser.role === 'admin') {
    return true;
  }
  return currentUser.id === resourceOwnerUserId;
}
