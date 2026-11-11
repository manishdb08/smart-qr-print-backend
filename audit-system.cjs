const { PrismaClient } = require('@prisma/client');
const { PDFDocument } = require('pdf-lib');

const BASE_URL = 'http://localhost:5000';
const AUTH_HEADER = { 'Authorization': 'Bearer test-token-customer' };
const AGENT_HEADER = { 'x-agent-secret': 'development_print_agent_secret_32_chars_long!' };

async function runAudit() {
  console.log('===========================================================');
  console.log('🚀 SMART QR PRINT — COMPLETE FULL-STACK SYSTEM AUDIT');
  console.log('===========================================================\n');

  let passedChecks = 0;
  let totalChecks = 0;

  function report(name, success, details = '') {
    totalChecks++;
    if (success) {
      passedChecks++;
      console.log(`✅ [PASS] ${name} ${details ? '— ' + details : ''}`);
    } else {
      console.error(`❌ [FAIL] ${name} ${details ? '— ' + details : ''}`);
    }
  }

  // 1. Health Probe
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const json = await res.json();
    report('System Health Probe (/health)', res.status === 200 && json.status === 'healthy', `Uptime: ${json.uptimeSeconds}s`);
  } catch (e) {
    report('System Health Probe (/health)', false, e.message);
  }

  // 2. Database Readiness & Latency (/ready)
  try {
    const res = await fetch(`${BASE_URL}/ready`);
    const json = await res.json();
    report('Supabase PostgreSQL Connection (/ready)', res.status === 200 && json.database?.healthy === true, `Mode: ${json.database?.mode}, Latency: ${json.database?.latencyMs}ms`);
  } catch (e) {
    report('Supabase PostgreSQL Connection (/ready)', false, e.message);
  }

  // 3. Swagger OpenAPI Documentation (/docs)
  try {
    const res = await fetch(`${BASE_URL}/docs`);
    const jsonRes = await fetch(`${BASE_URL}/docs/json`);
    const swaggerDoc = await jsonRes.json();
    report('OpenAPI Swagger Documentation (/docs)', res.status === 200 && jsonRes.status === 200, `API Title: "${swaggerDoc.info?.title}" v${swaggerDoc.info?.version}`);
  } catch (e) {
    report('OpenAPI Swagger Documentation (/docs)', false, e.message);
  }

  // 4. Frontend Root & Assets
  try {
    const htmlRes = await fetch(`${BASE_URL}/`);
    const htmlText = await htmlRes.text();
    const isNetlifyBuild = htmlText.includes('smart-qr-print') && htmlText.includes('index-Ch3ZOcoR.js');
    report('Root Frontend UI (Netlify Dashboard Build)', htmlRes.status === 200 && isNetlifyBuild, `HTML size: ${htmlText.length} bytes`);

    const jsRes = await fetch(`${BASE_URL}/assets/index-Ch3ZOcoR.js`);
    report('Frontend React JS Bundle (/assets/index-Ch3ZOcoR.js)', jsRes.status === 200, `Size: ${(await jsRes.text()).length} bytes`);

    const cssRes = await fetch(`${BASE_URL}/assets/index-CF7fJNaL.css`);
    report('Frontend Tailwind/CSS Bundle (/assets/index-CF7fJNaL.css)', cssRes.status === 200, `Size: ${(await cssRes.text()).length} bytes`);

    const favRes = await fetch(`${BASE_URL}/favicon.svg`);
    report('Frontend Favicon (/favicon.svg)', favRes.status === 200);
  } catch (e) {
    report('Frontend Static Assets', false, e.message);
  }

  // 5. Database Direct Check
  let dbPrinters = [];
  try {
    const prisma = new PrismaClient();
    dbPrinters = await prisma.printer.findMany({ include: { capabilities: true } });
    const userCount = await prisma.user.count();
    report('Database Models & Seeding', dbPrinters.length >= 2, `Printers: ${dbPrinters.length}, Users: ${userCount}`);
    await prisma.$disconnect();
  } catch (e) {
    report('Database Direct Check', false, e.message);
  }

  // 6. Fetch Active Hardware Printers via API
  let selectedPrinterId = '';
  try {
    const res = await fetch(`${BASE_URL}/v1/printers`);
    const json = await res.json();
    selectedPrinterId = json.data?.[0]?.id || 'lab-mono-01';
    report('API: List Printers (GET /v1/printers)', res.status === 200 && json.data?.length > 0, `Active: ${json.data?.map(p => p.id).join(', ')}`);
  } catch (e) {
    report('API: List Printers', false, e.message);
  }

  // 7. QR Session Creation (HMAC cryptographic token)
  let qrToken = '';
  try {
    const res = await fetch(`${BASE_URL}/v1/qr-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerId: selectedPrinterId })
    });
    const json = await res.json();
    qrToken = json.data?.token;
    report('API: Dynamic QR Session Token (POST /v1/qr-sessions)', res.status === 201 && Boolean(qrToken), `Expires: ${json.data?.expiresAt}`);
  } catch (e) {
    report('API: QR Session Token', false, e.message);
  }

  // 8. Generate Test PDF
  let pdfBytes = Buffer.alloc(0);
  try {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    page.drawText('Smart QR Print Automated System Audit 2026');
    pdfBytes = await doc.save();
    report('PDF Engine: Generate Valid Document (pdf-lib)', pdfBytes.length > 500, `${pdfBytes.length} bytes`);
  } catch (e) {
    report('PDF Engine: Generate Valid Document', false, e.message);
  }

  // 9. Presigned Upload URL
  let uploadSessionId = '';
  let uploadUrl = '';
  try {
    const res = await fetch(`${BASE_URL}/v1/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({
        originalFileName: 'audit_doc.pdf',
        fileSizeBytes: pdfBytes.length,
        mimeType: 'application/pdf',
        qrSessionToken: qrToken
      })
    });
    const json = await res.json();
    uploadSessionId = json.data?.uploadSessionId;
    uploadUrl = json.data?.uploadUrl;
    report('API: Presigned Upload URL (POST /v1/uploads/presign)', res.status === 200 && Boolean(uploadUrl), `Session ID: ${uploadSessionId}`);
  } catch (e) {
    report('API: Presigned Upload URL', false, e.message);
  }

  // 10. Binary PUT Storage
  try {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBytes
    });
    report('Storage Adapter: PUT Binary Payload', res.status === 200, `Storage Key verified`);
  } catch (e) {
    report('Storage Adapter: PUT Binary Payload', false, e.message);
  }

  // 11. Complete & Validate Upload (Magic Bytes, Checksum, Page Count, Malware Scan)
  let activeVersionId = '';
  try {
    const res = await fetch(`${BASE_URL}/v1/uploads/${uploadSessionId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({})
    });
    const json = await res.json();
    activeVersionId = json.data?.activeVersion?.id;
    const sha = json.data?.checksumSha256?.slice(0, 12);
    report('Validation Worker: File Inspection & Immutable Versioning', res.status === 200 && Boolean(activeVersionId), `SHA-256: ${sha}..., PageCount: ${json.data?.pageCount}, Status: ${json.data?.status}`);
  } catch (e) {
    report('Validation Worker: Complete Upload', false, e.message);
  }

  // 12. Create Draft Print Job
  let printJobId = '';
  let shortCode = '';
  try {
    const res = await fetch(`${BASE_URL}/v1/print-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({
        assetVersionId: activeVersionId,
        printerId: selectedPrinterId,
        copies: 1,
        isColor: false,
        isDuplex: false,
        pageSize: 'A4'
      })
    });
    const json = await res.json();
    printJobId = json.data?.id;
    shortCode = json.data?.shortCode;
    report('API: Create Draft Print Job (POST /v1/print-jobs)', res.status === 201 && Boolean(printJobId), `ShortCode: ${shortCode}, Status: ${json.data?.status}`);
  } catch (e) {
    report('API: Create Draft Print Job', false, e.message);
  }

  // 13. Server-Side Price Quote Engine (Paise, Hardware Capability Constraints)
  let quotePaise = 0;
  try {
    const res = await fetch(`${BASE_URL}/v1/print-jobs/${printJobId}/quote`, {
      method: 'POST',
      headers: AUTH_HEADER
    });
    const json = await res.json();
    quotePaise = json.data?.totalAmountPaise;
    report('Pricing Engine: Strict Integer Paise Quote (POST /print-jobs/:id/quote)', res.status === 200 && quotePaise > 0, `Amount: ${quotePaise} paise (₹${(quotePaise / 100).toFixed(2)})`);
  } catch (e) {
    report('Pricing Engine: Calculate Quote', false, e.message);
  }

  // 14. Razorpay Order Generation
  let rzpOrderId = '';
  try {
    const res = await fetch(`${BASE_URL}/v1/payments/razorpay/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({ printJobId })
    });
    const json = await res.json();
    rzpOrderId = json.data?.orderId;
    report('Payment Gateway: Create Razorpay Order (POST /payments/razorpay/orders)', res.status === 200 && Boolean(rzpOrderId), `OrderId: ${rzpOrderId}, Key: ${json.data?.keyId}`);
  } catch (e) {
    report('Payment Gateway: Create Order', false, e.message);
  }

  // 15. Razorpay HMAC Verification & Atomic Job Queueing
  try {
    const res = await fetch(`${BASE_URL}/v1/payments/razorpay/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      body: JSON.stringify({
        printJobId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: `pay_audit_${Date.now()}`,
        razorpay_signature: 'dev_mock_signature_approved'
      })
    });
    const json = await res.json();
    report('Payment Gateway: Verify Payment & Queue Job (POST /payments/razorpay/verify)', res.status === 200 && json.data?.jobStatus === 'queued', `Job Status: ${json.data?.jobStatus}`);
  } catch (e) {
    report('Payment Gateway: Verify Payment', false, e.message);
  }

  // 16. Hardware Printer Agent: Next Job Claiming
  try {
    const res = await fetch(`${BASE_URL}/v1/agent/jobs/claim`, {
      method: 'POST',
      headers: { ...AGENT_HEADER, 'x-printer-id': selectedPrinterId }
    });
    const json = await res.json();
    const claimedJob = json.data?.job;
    report('Hardware Printer Agent: Claim Queued Print Package (POST /agent/jobs/claim)', res.status === 200 && Boolean(claimedJob), claimedJob ? `Claimed Job: ${claimedJob.jobId}, ShortCode: ${claimedJob.shortCode}` : 'No jobs waiting');
  } catch (e) {
    report('Hardware Printer Agent: Claim Job', false, e.message);
  }

  console.log('\n===========================================================');
  console.log(`📊 AUDIT RESULT: ${passedChecks} / ${totalChecks} CHECKS PASSED (${Math.round((passedChecks / totalChecks) * 100)}%)`);
  console.log('===========================================================');
}

runAudit();
