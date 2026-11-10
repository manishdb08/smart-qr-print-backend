import { prisma } from '../../db/client.js';
import { assertResourceOwnership } from '../../auth/rbac.js';
import {
  createRazorpayOrderOnGateway,
  verifyPaymentHmacSignature,
  verifyWebhookHmacSignature,
  processRazorpayRefund,
} from '../../payments/razorpayClient.js';
import { recordAuditEvent } from '../../middleware/audit.js';
import { config } from '../../config/index.js';
import { AuthenticatedUser } from '../../types/index.js';
import { VerifyPaymentInput } from './payment.types.js';

export async function createPaymentOrder(
  printJobId: string,
  currentUser: AuthenticatedUser
) {
  // 1. Fetch print job and latest active quote
  const job = await prisma.printJob.findUnique({
    where: { id: printJobId },
    include: {
      priceQuotes: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!job) {
    const error = new Error(`Print job '${printJobId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, job.userId)) {
    const error = new Error('Access denied: You do not have permission to pay for this print job.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  const quote = job.priceQuotes[0];
  if (!quote) {
    const error = new Error('No pricing quote found for this print job. Please request a quote first via POST /print-jobs/:id/quote.');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  if (new Date() > quote.expiresAt) {
    const error = new Error('Pricing quote has expired. Please request a fresh quote.');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // 2. Create Razorpay order exclusively using server-calculated integer paise amount
  const gatewayOrder = await createRazorpayOrderOnGateway({
    amountPaise: quote.totalAmountPaise,
    receipt: job.shortCode,
    currency: quote.currency,
    notes: {
      printJobId: job.id,
      userId: currentUser.id,
      pricingRuleVersion: quote.pricingRuleVersion,
    },
  });

  // 3. Persist RazorpayOrder in DB
  const razorpayOrder = await prisma.razorpayOrder.create({
    data: {
      printJobId: job.id,
      priceQuoteId: quote.id,
      razorpayOrderId: gatewayOrder.id,
      amountPaise: quote.totalAmountPaise,
      currency: quote.currency,
      status: 'created',
      receipt: gatewayOrder.receipt,
    },
  });

  // 4. Update job status to payment_pending
  await prisma.printJob.update({
    where: { id: job.id },
    data: { status: 'payment_pending' },
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'RAZORPAY_ORDER_CREATED',
    entityType: 'RazorpayOrder',
    entityId: razorpayOrder.id,
    metadata: {
      razorpayOrderId: gatewayOrder.id,
      amountPaise: quote.totalAmountPaise,
    },
  });

  return {
    orderId: gatewayOrder.id,
    amountPaise: quote.totalAmountPaise,
    currency: quote.currency,
    keyId: config.RAZORPAY_KEY_ID,
    shortCode: job.shortCode,
  };
}

export async function verifyPayment(
  input: VerifyPaymentInput,
  currentUser: AuthenticatedUser
) {
  // 1. Server-side HMAC Signature Verification
  const isSignatureValid = verifyPaymentHmacSignature({
    razorpayOrderId: input.razorpay_order_id,
    razorpayPaymentId: input.razorpay_payment_id,
    razorpaySignature: input.razorpay_signature,
  });

  if (!isSignatureValid) {
    const error = new Error('Invalid Razorpay payment signature. Payment verification failed.');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // 2. Fetch order and job
  const razorpayOrder = await prisma.razorpayOrder.findUnique({
    where: { razorpayOrderId: input.razorpay_order_id },
    include: { printJob: true },
  });

  if (!razorpayOrder) {
    const error = new Error(`Razorpay order '${input.razorpay_order_id}' not found in database.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (razorpayOrder.printJobId !== input.printJobId) {
    const error = new Error('Order does not match specified print job ID.');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // 3. Atomic transition: order paid, job paid, job queued for printing
  const eventId = `verify_${input.razorpay_payment_id}`;

  await prisma.$transaction(async (tx) => {
    await tx.razorpayOrder.update({
      where: { id: razorpayOrder.id },
      data: { status: 'paid' },
    });

    await tx.printJob.update({
      where: { id: razorpayOrder.printJobId },
      data: {
        status: 'queued', // paid and ready for agent claim
      },
    });

    // Record verified payment event
    await tx.paymentEvent.upsert({
      where: { eventId },
      update: {},
      create: {
        eventId,
        razorpayOrderId: razorpayOrder.id,
        eventType: 'client.verified',
        payload: {
          paymentId: input.razorpay_payment_id,
          orderId: input.razorpay_order_id,
        },
        signatureVerified: true,
      },
    });
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'PAYMENT_VERIFIED_SUCCESSFULLY',
    entityType: 'PrintJob',
    entityId: razorpayOrder.printJobId,
    metadata: {
      paymentId: input.razorpay_payment_id,
      amountPaise: razorpayOrder.amountPaise,
    },
  });

  return {
    success: true,
    status: 'paid',
    jobStatus: 'queued',
    printJobId: razorpayOrder.printJobId,
  };
}

export async function handleWebhookEvent(
  rawBody: string | Buffer,
  signatureHeader: string,
  payload: any
) {
  // 1. Constant-time signature verification
  const isValid = verifyWebhookHmacSignature(rawBody, signatureHeader);
  if (!isValid) {
    const error = new Error('Unauthorized: Invalid Razorpay webhook signature.');
    (error as unknown as { statusCode: number }).statusCode = 401;
    throw error;
  }

  const eventType = payload.event as string;
  const eventId = (payload.id as string) || `wh_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // 2. Idempotency Check: prevent duplicate event processing
  const existingEvent = await prisma.paymentEvent.findUnique({
    where: { eventId },
  });

  if (existingEvent) {
    return { received: true, deduplicated: true, eventId };
  }

  // 3. Process event type
  if (eventType === 'order.paid' || eventType === 'payment.captured') {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const razorpayOrderId = paymentEntity.order_id || payload.payload?.order?.entity?.id;

    if (razorpayOrderId) {
      const dbOrder = await prisma.razorpayOrder.findUnique({
        where: { razorpayOrderId },
      });

      if (dbOrder) {
        await prisma.$transaction(async (tx) => {
          await tx.razorpayOrder.update({
            where: { id: dbOrder.id },
            data: { status: 'paid' },
          });

          await tx.printJob.update({
            where: { id: dbOrder.printJobId },
            data: { status: 'queued' },
          });

          await tx.paymentEvent.create({
            data: {
              eventId,
              razorpayOrderId: dbOrder.id,
              eventType,
              payload: payload,
              signatureVerified: true,
            },
          });
        });
      }
    }
  } else if (eventType === 'payment.failed') {
    const paymentEntity = payload.payload?.payment?.entity || {};
    const razorpayOrderId = paymentEntity.order_id;
    if (razorpayOrderId) {
      const dbOrder = await prisma.razorpayOrder.findUnique({
        where: { razorpayOrderId },
      });
      if (dbOrder) {
        await prisma.printJob.update({
          where: { id: dbOrder.printJobId },
          data: { status: 'awaiting_payment' },
        });
      }
    }
  }

  return { received: true, eventId };
}

export async function requestJobRefund(
  printJobId: string,
  reason: string | undefined,
  currentUser: AuthenticatedUser
) {
  const job = await prisma.printJob.findUnique({
    where: { id: printJobId },
    include: {
      razorpayOrders: {
        where: { status: 'paid' },
        take: 1,
      },
    },
  });

  if (!job) {
    const error = new Error(`Print job '${printJobId}' not found.`);
    (error as unknown as { statusCode: number }).statusCode = 404;
    throw error;
  }

  if (!assertResourceOwnership(currentUser, job.userId)) {
    const error = new Error('Access denied: You cannot request a refund for this job.');
    (error as unknown as { statusCode: number }).statusCode = 403;
    throw error;
  }

  const paidOrder = job.razorpayOrders[0];
  if (!paidOrder) {
    const error = new Error('No completed payment order found to refund.');
    (error as unknown as { statusCode: number }).statusCode = 400;
    throw error;
  }

  // Update status to refund_pending
  await prisma.printJob.update({
    where: { id: job.id },
    data: { status: 'refund_pending' },
  });

  // Call refund on payment gateway
  await processRazorpayRefund(paidOrder.razorpayOrderId, paidOrder.amountPaise);

  await prisma.printJob.update({
    where: { id: job.id },
    data: { status: 'refunded', failureReason: reason || 'Customer requested refund' },
  });

  await recordAuditEvent({
    userId: currentUser.id,
    actorType: 'user',
    action: 'JOB_REFUNDED',
    entityType: 'PrintJob',
    entityId: job.id,
    metadata: {
      amountPaise: paidOrder.amountPaise,
      reason,
    },
  });

  return {
    success: true,
    status: 'refunded',
    amountPaise: paidOrder.amountPaise,
  };
}

export async function reconcilePendingPayments() {
  const cutoffTime = new Date(Date.now() - 15 * 60 * 1000); // 15 minutes ago

  const staleJobs = await prisma.printJob.findMany({
    where: {
      status: 'payment_pending',
      updatedAt: { lt: cutoffTime },
    },
  });

  for (const job of staleJobs) {
    await prisma.printJob.update({
      where: { id: job.id },
      data: { status: 'awaiting_payment' },
    });
  }

  return { reconciledCount: staleJobs.length };
}
