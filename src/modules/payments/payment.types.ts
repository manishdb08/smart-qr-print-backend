import { z } from 'zod';

export const createRazorpayOrderSchema = z.object({
  printJobId: z.string().min(1, 'printJobId is required'),
});

export type CreateRazorpayOrderInput = z.infer<typeof createRazorpayOrderSchema>;

export const verifyPaymentSchema = z.object({
  printJobId: z.string().min(1, 'printJobId is required'),
  razorpay_order_id: z.string().min(1, 'razorpay_order_id is required'),
  razorpay_payment_id: z.string().min(1, 'razorpay_payment_id is required'),
  razorpay_signature: z.string().min(1, 'razorpay_signature is required'),
});

export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

export const refundRequestSchema = z.object({
  reason: z.string().optional(),
});

export type RefundRequestInput = z.infer<typeof refundRequestSchema>;
