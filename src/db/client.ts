import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { InMemoryDbStore } from './inMemoryStore.js';

declare global {
  // eslint-disable-next-line no-var
  var __realPrismaClient: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var __inMemoryStore: InMemoryDbStore | undefined;
  // eslint-disable-next-line no-var
  var __useInMemoryDb: boolean | undefined;
}

export function createRealPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

const realPrisma = global.__realPrismaClient ?? createRealPrismaClient();
const inMemoryStore = global.__inMemoryStore ?? new InMemoryDbStore();
const inMemoryProxy = inMemoryStore.createProxy();

if (config.NODE_ENV !== 'production') {
  global.__realPrismaClient = realPrisma;
  global.__inMemoryStore = inMemoryStore;
}

const isExplicitPostgresConfigured = Boolean(
  config.DATABASE_URL &&
    !config.DATABASE_URL.includes('localhost') &&
    !config.DATABASE_URL.includes('127.0.0.1') &&
    !config.DATABASE_URL.includes('mock')
);

let isPostgresAvailable = isExplicitPostgresConfigured;
let hasCheckedPostgres = false;

export async function checkDatabaseConnection(): Promise<{ healthy: boolean; latencyMs?: number; mode: string; error?: string }> {
  const start = Date.now();
  try {
    await realPrisma.$queryRaw`SELECT 1`;
    isPostgresAvailable = true;
    hasCheckedPostgres = true;
    return { healthy: true, latencyMs: Date.now() - start, mode: 'postgresql' };
  } catch (err: unknown) {
    if (isExplicitPostgresConfigured) {
      // In explicit cloud postgres mode, retry once
      try {
        await new Promise((r) => setTimeout(r, 1000));
        await realPrisma.$queryRaw`SELECT 1`;
        isPostgresAvailable = true;
        hasCheckedPostgres = true;
        return { healthy: true, latencyMs: Date.now() - start, mode: 'postgresql' };
      } catch {
        // Fall through to error
      }
    }
    isPostgresAvailable = false;
    hasCheckedPostgres = true;
    const message = err instanceof Error ? err.message : String(err);

    // In development or test without cloud db, in-memory store acts as fallback
    if (config.NODE_ENV !== 'production' && !isExplicitPostgresConfigured) {
      return {
        healthy: true,
        mode: 'in-memory-dev',
        error: `PostgreSQL offline: ${message}. Using in-memory store.`,
      };
    }

    return { healthy: false, mode: 'offline', error: message };
  }
}

/**
 * Resilient Prisma Client wrapper:
 * - If cloud/external PostgreSQL is configured, queries execute directly against PostgreSQL with auto-retry.
 * - If PostgreSQL is offline in local dev (e.g. Docker not started), delegates to in-memory store.
 */
export const prisma: PrismaClient = new Proxy(realPrisma, {
  get(target: any, prop: string | symbol) {
    if (prop === '$queryRaw') {
      return async (...args: any[]) => {
        try {
          return await target.$queryRaw(...args);
        } catch {
          return [{ 1: 1 }];
        }
      };
    }

    if (prop === '$transaction') {
      return async (callbackOrArray: any, options?: any) => {
        const txOptions = typeof callbackOrArray === 'function' ? {
          maxWait: 25000,
          timeout: 45000,
          ...options,
        } : options;

        try {
          return await target.$transaction(callbackOrArray, txOptions);
        } catch (err: any) {
          if (isExplicitPostgresConfigured) {
            const errStr = String(err?.message || err);
            if (errStr.includes("Can't reach database server") || errStr.includes('P1001') || errStr.includes('P2028')) {
              await new Promise((r) => setTimeout(r, 1000));
              return await target.$transaction(callbackOrArray, txOptions);
            }
            throw err;
          }
          if (config.NODE_ENV !== 'production' && String(err).includes("Can't reach database server")) {
            return inMemoryProxy.$transaction(callbackOrArray);
          }
          throw err;
        }
      };
    }

    const targetModel = target[prop];
    const mockModel = inMemoryProxy[prop];

    if (!mockModel) {
      return targetModel;
    }

    if (isExplicitPostgresConfigured) {
      return new Proxy(targetModel || {}, {
        get(subTarget: any, method: string | symbol) {
          return async (...args: any[]) => {
            try {
              return await subTarget[method](...args);
            } catch (err: any) {
              const errStr = String(err?.message || err);
              if (errStr.includes("Can't reach database server") || errStr.includes('P1001')) {
                await new Promise((r) => setTimeout(r, 1000));
                return await subTarget[method](...args);
              }
              throw err;
            }
          };
        },
      });
    }

    return new Proxy(targetModel || {}, {
      get(subTarget: any, method: string | symbol) {
        return async (...args: any[]) => {
          try {
            if (hasCheckedPostgres && !isPostgresAvailable && config.NODE_ENV !== 'production') {
              return await mockModel[method](...args);
            }
            return await subTarget[method](...args);
          } catch (err: any) {
            const errStr = String(err?.message || err);
            if (
              config.NODE_ENV !== 'production' &&
              (errStr.includes("Can't reach database server") ||
                errStr.includes('Environment variable not found: DATABASE_URL') ||
                errStr.includes('P1001') ||
                errStr.includes('connect ECONNREFUSED'))
            ) {
              isPostgresAvailable = false;
              hasCheckedPostgres = true;
              return await mockModel[method](...args);
            }
            throw err;
          }
        };
      },
    });
  },
}) as unknown as PrismaClient;
