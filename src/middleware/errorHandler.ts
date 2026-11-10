import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config/index.js';

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const requestId = request.id;

  request.log.error({
    err: error,
    requestId,
    url: request.raw.url,
    method: request.raw.method,
  }, 'Request encountered error');

  // 1. Zod Validation Errors
  if (error instanceof ZodError) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload or parameters',
        details: error.flatten().fieldErrors,
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // 2. Fastify Schema Validation Error
  if (error.validation) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'SCHEMA_VALIDATION_ERROR',
        message: error.message,
        details: error.validation,
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // 3. Fastify Rate Limit Error
  if (error.statusCode === 429) {
    return reply.status(429).send({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please slow down and try again later.',
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // 4. Custom HTTP Errors
  const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
    ? error.statusCode
    : 500;

  // Never expose raw stack traces or internal secrets in non-development mode
  const safeMessage = statusCode >= 500 && config.NODE_ENV === 'production'
    ? 'An internal server error occurred. Please contact support with the requestId.'
    : error.message || 'An unexpected error occurred';

  return reply.status(statusCode).send({
    success: false,
    error: {
      code: error.code || (statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR'),
      message: safeMessage,
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString(),
    },
  });
}
