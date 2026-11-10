import { FastifyRequest } from 'fastify';

export type UserRole = 'customer' | 'printer_operator' | 'admin' | 'print_agent';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  supabaseUid?: string;
  name?: string;
}

export interface AuthenticatedAgent {
  id: string;
  printerId: string;
  agentName: string;
  role: 'print_agent';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    agent?: AuthenticatedAgent;
    id: string;
  }
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    requestId: string;
    timestamp: string;
  };
}

export interface QrSessionTokenPayload {
  sessionId: string;
  printerId: string;
  expiresAt: number;
}
