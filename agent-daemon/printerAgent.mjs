#!/usr/bin/env node
/**
 * Smart QR Print - Hardware Printer Agent Daemon
 * -------------------------------------------------------------
 * Runs as a local service on Raspberry Pi, Linux, or Windows print servers.
 * Connects securely to the Smart QR Print Backend via shared secret, polls for
 * paid and approved jobs, downloads signed print packages, verifies SHA-256 checksums,
 * dispatches to local CUPS or Windows spooler, and reports hardware status.
 *
 * Usage:
 *   node printerAgent.mjs
 * Or with custom settings:
 *   PRINTER_ID=library-a4-01 BACKEND_URL=http://localhost:5000 node printerAgent.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration with sensible defaults
const CONFIG = {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',
  apiPrefix: process.env.API_PREFIX || '/v1',
  printerId: process.env.PRINTER_ID || 'library-a4-01',
  agentSecret: process.env.AGENT_SECRET || 'development_print_agent_secret_32_chars_long!',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
  spoolDir: path.resolve(__dirname, 'spool'),
  dryRun: process.env.DRY_RUN !== 'false', // Default true for safe testing unless DRY_RUN=false
};

// Ensure local spool directory exists
if (!fs.existsSync(CONFIG.spoolDir)) {
  fs.mkdirSync(CONFIG.spoolDir, { recursive: true });
}

let isRunning = true;

console.log('============================================================');
console.log(' 🖨️  Smart QR Print - Hardware Daemon Initializing');
console.log('============================================================');
console.log(`📡 Backend URL:      ${CONFIG.backendUrl}${CONFIG.apiPrefix}`);
console.log(`🆔 Assigned Printer: ${CONFIG.printerId}`);
console.log(`📁 Spool Directory:  ${CONFIG.spoolDir}`);
console.log(`🧪 Simulation Mode:  ${CONFIG.dryRun ? 'ON (Files saved to spool)' : 'OFF (Physical print)'}`);
console.log('============================================================\n');

/**
 * Common headers for Agent API calls
 */
function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-agent-secret': CONFIG.agentSecret,
    'x-printer-id': CONFIG.printerId,
  };
}

/**
 * 1. Poll for next available job
 */
async function claimNextJob() {
  const url = `${CONFIG.backendUrl}${CONFIG.apiPrefix}/agent/jobs/claim`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.warn(`⚠️ Poll failed [HTTP ${res.status}]: ${errorText}`);
      return null;
    }

    const data = await res.json();
    return data?.data?.job || null;
  } catch (err) {
    console.error(`❌ Network error while polling backend (${url}): ${err.message}`);
    return null;
  }
}

/**
 * 2. Update job status on backend
 */
async function updateJobStatus(jobId, status, failureReason = null, metadata = {}) {
  const url = `${CONFIG.backendUrl}${CONFIG.apiPrefix}/agent/jobs/${jobId}/status`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        status,
        failureReason: failureReason || undefined,
        metadata: {
          timestamp: new Date().toISOString(),
          agentPid: process.pid,
          ...metadata,
        },
      }),
    });

    if (!res.ok) {
      console.error(`❌ Failed to update job ${jobId} status to '${status}': HTTP ${res.status}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`❌ Error updating job ${jobId} status: ${err.message}`);
    return false;
  }
}

/**
 * 3. Download signed package and verify SHA-256 integrity
 */
async function downloadAndVerifyPackage(packageUrl, expectedChecksum, fileExtension = 'pdf') {
  const absoluteUrl = packageUrl.startsWith('http')
    ? packageUrl
    : `${CONFIG.backendUrl}${packageUrl}`;

  console.log(`📥 Downloading print package from: ${absoluteUrl}`);
  const response = await fetch(absoluteUrl);
  if (!response.ok) {
    throw new Error(`Package download failed with status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Validate SHA-256 checksum
  const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedChecksum && actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error(
      `Checksum mismatch! Expected: ${expectedChecksum}, Actual: ${actualChecksum}. File may be tampered.`
    );
  }

  const fileName = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${fileExtension}`;
  const filePath = path.join(CONFIG.spoolDir, fileName);
  fs.writeFileSync(filePath, buffer);

  console.log(`✅ Download verified (SHA-256: ${actualChecksum.substring(0, 12)}...) -> ${filePath}`);
  return { filePath, bufferSize: buffer.length };
}

/**
 * 4. Dispatch file to hardware printer or simulator
 */
async function printDocument(filePath, settings) {
  console.log(`🖨️ Sending document to print head with settings:`, settings);

  if (CONFIG.dryRun) {
    // Simulated print output
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Simulate 2-second print duration
    console.log(`✨ [SIMULATION] Printed ${settings.copies || 1} copies successfully.`);
    return { success: true, hardwareJobId: `SIM-${Date.now()}` };
  }

  // Physical printing dispatch
  if (process.platform === 'win32') {
    // Windows spool command
    const printCmd = `powershell -Command "Start-Process -FilePath '${filePath}' -Verb Print -PassThru"`;
    await execAsync(printCmd);
    return { success: true, hardwareJobId: `WIN-${Date.now()}` };
  } else {
    // Linux / macOS (CUPS)
    const cupsOptions = [];
    if (settings.copies) cupsOptions.push(`-# ${settings.copies}`);
    if (settings.isDuplex) cupsOptions.push(`-o sides=two-sided-long-edge`);
    if (settings.isColor) cupsOptions.push(`-o ColorModel=Color`);
    else cupsOptions.push(`-o ColorModel=KGray`);

    const lpCmd = `lp ${cupsOptions.join(' ')} "${filePath}"`;
    const { stdout } = await execAsync(lpCmd);
    return { success: true, hardwareJobId: stdout.trim() || `CUPS-${Date.now()}` };
  }
}

/**
 * 5. Full Job Lifecycle Execution
 */
async function processJob(job) {
  const { jobId, shortCode, packageUrl, settings, document } = job;
  console.log(`\n🔔 New print job claimed: [${shortCode}] (ID: ${jobId})`);
  console.log(`📄 Document: ${document.originalFileName} (${document.pageCount} pages, ${document.mimeType})`);

  try {
    // Step 1: Notify backend job is claimed by hardware
    await updateJobStatus(jobId, 'claimed_by_printer');

    // Step 2: Download & verify signed file
    const ext = document.mimeType.includes('png')
      ? 'png'
      : document.mimeType.includes('jpeg') || document.mimeType.includes('jpg')
      ? 'jpg'
      : 'pdf';

    const { filePath } = await downloadAndVerifyPackage(packageUrl, document.checksumSha256, ext);

    // Step 3: Notify backend status is printing
    await updateJobStatus(jobId, 'printing', null, { spoolPath: filePath });

    // Step 4: Execute hardware print
    const printResult = await printDocument(filePath, settings);

    // Step 5: Notify backend status is completed
    await updateJobStatus(jobId, 'completed', null, {
      hardwareJobId: printResult.hardwareJobId,
      pagesPrinted: document.pageCount * (settings.copies || 1),
    });

    console.log(`🎉 Job [${shortCode}] successfully printed and reported completed!\n`);
  } catch (err) {
    console.error(`❌ Error during job [${shortCode}] execution:`, err);
    await updateJobStatus(jobId, 'failed', err.message);
  }
}

/**
 * Main polling loop
 */
async function daemonLoop() {
  while (isRunning) {
    try {
      const job = await claimNextJob();
      if (job) {
        await processJob(job);
      }
    } catch (err) {
      console.error(`⚠️ Polling loop error: ${err.message}`);
    }

    if (isRunning) {
      await new Promise((resolve) => setTimeout(resolve, CONFIG.pollIntervalMs));
    }
  }
}

// Graceful termination handling
const shutdown = () => {
  console.log('\n🛑 Stopping Printer Agent Daemon gracefully...');
  isRunning = false;
  setTimeout(() => process.exit(0), 1000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start polling
daemonLoop();
