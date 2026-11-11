import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  API_PREFIX: z.string().default('/v1'),

  // Database
  DATABASE_URL: z.string().default('postgresql://smartqr:smartqr_secret@localhost:5432/smart_qr_print?schema=public'),

  // Redis
  REDIS_URL: z.string().default('redis://:redis_secret@localhost:6379/0'),

  // Supabase Auth & Storage
  SUPABASE_URL: z.string().default('https://mock.supabase.co'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default('mock_supabase_service_role_key_for_dev_mode_12345'),
  STORAGE_BUCKET: z.string().default('smart-qr-print-documents'),

  // Razorpay
  RAZORPAY_KEY_ID: z.string().default('rzp_test_mock_key_id'),
  RAZORPAY_KEY_SECRET: z.string().default('mock_razorpay_secret_dev_12345'),
  RAZORPAY_WEBHOOK_SECRET: z.string().default('mock_razorpay_webhook_secret_dev_12345'),

  // Gemini API
  GEMINI_API_KEY: z.string().default('mock_gemini_api_key_dev'),

  // Printer Agent Shared Secret
  PRINT_AGENT_SHARED_SECRET: z.string().min(16).default('development_print_agent_secret_32_chars_long!'),

  // CORS
  CORS_ORIGIN: z.string().default('*'),

  // Fallback JWT secret for QR signing
  JWT_SECRET: z.string().min(16).default('jwt_super_secret_for_smart_qr_dev_environment_32chars!'),

  // QR Session TTL
  QR_SESSION_TTL_MINUTES: z.coerce.number().default(15),

  // File Upload Limits
  MAX_FILE_SIZE_BYTES: z.coerce.number().default(25 * 1024 * 1024), // 25MB
  MAX_PDF_PAGES: z.coerce.number().default(150),
  ALLOWED_MIME_TYPES: z.string().default('application/pdf,image/jpeg,image/png,image/webp'),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment configuration:', parsedEnv.error.format());
  throw new Error('Environment configuration validation failed');
}

export const config = parsedEnv.data;

export const PRICING_RULES = {
  version: 'v1.0.0',
  baseMonoPagePaise: 200,      // 200 paise = 2 INR
  baseColorPagePaise: 800,     // 800 paise = 8 INR
  duplexDiscountPercent: 10,   // 10% discount when duplex printing
  minOrderPaise: 200,          // 200 paise minimum order
  currency: 'INR'
} as const;
