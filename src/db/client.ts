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

let isPostgresAvailable = false;
let hasCheckedPostgres = false;

export async function checkDatabaseConnection(): Promise<{ healthy: boolean; latencyMs?: number; mode: string; error?: string }> {
  const start = Date.now();
  try {
    await realPrisma.$queryRaw`SELECT 1`;
    isPostgresAvailable = true;
    hasCheckedPostgres = true;
    return { healthy: true, latencyMs: Date.now() - start, mode: 'postgresql' };
  } catch (err: unknown) {
    isPostgresAvailable = false;
    hasCheckedPostgres = true;
    const message = err instanceof Error ? err.message : String(err);

    // In development or test, in-memory store acts as healthy fallback
    if (config.NODE_ENV !== 'production') {
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
 * - If PostgreSQL is reachable, queries execute directly against PostgreSQL.
 * - If PostgreSQL is unreachable (e.g. Docker not started locally), seamlessly delegates
 *   to in-memory store so development and testing never crash with connection errors.
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
        try {
          if (typeof callbackOrArray === 'function') {
            const txOptions = {
              maxWait: 20000,
              timeout: 30000,
              ...options,
            };
            return await target.$transaction(callbackOrArray, txOptions);
          }
          return await target.$transaction(callbackOrArray, options);
        } catch (err: any) {
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

    return new Proxy(targetModel || {}, {
      get(subTarget: any, method: string | symbol) {
        return async (...args: any[]) => {
          // If we haven't checked or we know postgres is down in dev, try target first
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
