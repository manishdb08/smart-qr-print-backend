import { RedisOptions } from 'ioredis';
import { config } from '../config/index.js';

export function getRedisOptions(): RedisOptions {
  try {
    const url = new URL(config.REDIS_URL);
    return {
      host: url.hostname || 'localhost',
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => {
        if (config.NODE_ENV === 'test') return null; // Don't hang during tests
        return Math.min(times * 100, 3000);
      },
    };
  } catch {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}
