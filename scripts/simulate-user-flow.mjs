#!/usr/bin/env node
/**
 * End-to-End Simulation Script
 * Simulates a customer scanning a kiosk QR code, uploading a PDF, receiving an exact price quote,
 * paying, and the hardware agent claiming & printing the document!
 */

import crypto from 'node:crypto';

const BASE_URL = 'http://localhost:5000/v1';

async function runSimulation() {
  console.log('============================================================');
  console.log(' 📱 Smart QR Print - End-to-End Flow Simulator');
  console.log('============================================================\n');

  // STEP 1: Scan dynamic QR Code on physical kiosk
  console.log('▶ [Step 1] Customer scans QR code on kiosk "library-a4-01"...');
  const qrRes = await fetch(`${BASE_URL}/qr-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ printerId: 'library-a4-01' }),
  });
  const qrJson = await qrRes.json();
  const sessionToken = qrJson?.data?.token;
  console.log(`✅ Session Created! Token: ${sessionToken.substring(0, 16)}... (Expires: ${qrJson?.data?.expiresAt})\n`);

  // STEP 2: Request presigned upload URL
  console.log('▶ [Step 2] Customer selects a PDF document to upload...');
  const dummyPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF'
  );

  const customerAuthHeaders = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test-token-customer',
  };

  const presignRes = await fetch(`${BASE_URL}/uploads/presign`, {
    method: 'POST',
    headers: customerAuthHeaders,
    body: JSON.stringify({
      originalFileName: 'lecture_notes.pdf',
      fileSizeBytes: dummyPdf.length,
      mimeType: 'application/pdf',
      qrSessionToken: sessionToken,
    }),
  });
  const presignData = await presignRes.json();
  const { uploadUrl, storageKey } = presignData.data;
  console.log(`✅ Presigned URL generated! Storage Key: ${storageKey}\n`);

  // STEP 3: Upload bytes to Storage Provider
  console.log('▶ [Step 3] Uploading binary payload directly to storage...');
  const targetUploadUrl = uploadUrl.startsWith('http') ? uploadUrl : `http://localhost:5000${uploadUrl}`;
  const uploadBinaryRes = await fetch(targetUploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: dummyPdf,
  });
  console.log(`✅ Binary uploaded successfully (HTTP ${uploadBinaryRes.status})\n`);

  // STEP 4: Confirm upload & validate magic bytes
  console.log('▶ [Step 4] Confirming upload and verifying SHA-256 & magic bytes...');
  const completeRes = await fetch(`${BASE_URL}/uploads/complete`, {
    method: 'POST',
    headers: customerAuthHeaders,
    body: JSON.stringify({
      storageKey,
      originalFileName: 'lecture_notes.pdf',
      mimeType: 'application/pdf',
      qrSessionToken: sessionToken,
    }),
  });
  const completeData = await completeRes.json();
  const assetId = completeData?.data?.assetId;
  const versionId = completeData?.data?.activeVersion?.id;
  const pageCount = completeData?.data?.pageCount;
  console.log(`✅ Document confirmed! Asset ID: ${assetId} (Version: ${versionId}, Pages: ${pageCount})\n`);

  // STEP 5: Request server-side pricing quote (Draft Print Job)
  console.log('▶ [Step 5] Requesting server-side price quote for 2 copies, Color, Duplex...');
  const draftRes = await fetch(`${BASE_URL}/print-jobs`, {
    method: 'POST',
    headers: customerAuthHeaders,
    body: JSON.stringify({
      assetVersionId: versionId,
      printerId: 'library-a4-01',
      copies: 2,
      isColor: true,
      isDuplex: true,
      pageSize: 'A4',
    }),
  });
  const draftData = await draftRes.json();
  const printJob = draftData?.data;

  // Request official server-side quote
  const quoteRes = await fetch(`${BASE_URL}/print-jobs/${printJob.id}/quote`, {
    method: 'POST',
    headers: customerAuthHeaders,
  });
  const quoteData = await quoteRes.json();
  const quotedJob = quoteData?.data;
  const quotePaise = quotedJob.totalAmountPaise;
  const quoteRupees = (quotePaise / 100).toFixed(2);
  console.log(`💰 Official Server Quote: ₹${quoteRupees} (${quotePaise} paise)`);
  console.log(`   Job Status: "${quotedJob.status}", ShortCode: [${quotedJob.shortCode}]\n`);

  // STEP 6: Initiate Razorpay Order
  console.log('▶ [Step 6] Customer clicks "Pay Now" -> Creating Razorpay Order...');
  const orderRes = await fetch(`${BASE_URL}/payments/razorpay/orders`, {
    method: 'POST',
    headers: customerAuthHeaders,
    body: JSON.stringify({
      printJobId: printJob.id,
    }),
  });
  const orderData = await orderRes.json();
  const razorpayOrderId = orderData?.data?.orderId;
  const amountPaise = orderData?.data?.amountPaise;
  console.log(`✅ Razorpay Order Generated! Order ID: ${razorpayOrderId} (Amount: ₹${(amountPaise / 100).toFixed(2)})\n`);

  // STEP 7: Customer completes payment on checkout modal
  console.log('▶ [Step 7] Customer completes payment modal -> Verifying HMAC signature...');
  const simPaymentId = `pay_sim_${Date.now()}`;
  const validHmacSignature = crypto
    .createHmac('sha256', 'your_test_razorpay_secret_here')
    .update(`${razorpayOrderId}|${simPaymentId}`)
    .digest('hex');

  const verifyRes = await fetch(`${BASE_URL}/payments/razorpay/verify`, {
    method: 'POST',
    headers: customerAuthHeaders,
    body: JSON.stringify({
      printJobId: printJob.id,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: simPaymentId,
      razorpay_signature: validHmacSignature,
    }),
  });
  const verifyData = await verifyRes.json();
  console.log(`✅ Payment Verified! Status: "${verifyData?.data?.status}", Job Queue: "${verifyData?.data?.jobStatus}" (ShortCode: ${printJob.shortCode})\n`);

  // STEP 8: Local Printer Hardware Daemon Claims & Prints the Job
  console.log('▶ [Step 8] Hardware printer agent polls backend and claims the job...');
  const claimRes = await fetch(`${BASE_URL}/agent/jobs/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-secret': 'development_print_agent_secret_32_chars_long!',
      'x-printer-id': 'library-a4-01',
    },
    body: JSON.stringify({}),
  });
  const claimData = await claimRes.json();
  const claimedJob = claimData?.data?.job;

  if (claimedJob && claimedJob.jobId === printJob.id) {
    console.log(`🖨️ Hardware Daemon CLAIMED Job: [${claimedJob.shortCode}]`);
    console.log(`   Signed Package Download URL: ${claimedJob.packageUrl}`);
    console.log(`   Printing ${claimedJob.settings.copies} copies on A4 paper...`);

    // Report Completed
    await fetch(`${BASE_URL}/agent/jobs/${claimedJob.jobId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-secret': 'development_print_agent_secret_32_chars_long!',
        'x-printer-id': 'library-a4-01',
      },
      body: JSON.stringify({
        status: 'completed',
        metadata: { pagesPrinted: 2, hardwareStatus: 'SUCCESS' },
      }),
    });
    console.log(`🎉 Job marked "completed" on printer hardware!\n`);
  } else {
    console.log('ℹ️ No job claimed or job claimed by another worker.');
  }

  console.log('============================================================');
  console.log(' 🏁 End-to-End Simulation Finished Successfully!');
  console.log('============================================================');
}

runSimulation().catch(console.error);
