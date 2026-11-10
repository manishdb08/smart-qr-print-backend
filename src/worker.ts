import { initTransformationWorker } from './queue/transformationQueue.js';
import { config } from './config/index.js';

async function startWorker() {
  console.log(`⚙️ Starting Smart QR Print Background Worker daemon (ENV: ${config.NODE_ENV})...`);

  const worker = initTransformationWorker();
  if (!worker) {
    console.warn('⚠️ Worker initialization skipped (environment is configured as test or in-process).');
    return;
  }

  console.log(`✅ BullMQ Transformation Worker active on queue 'document-transformations' with concurrency 5`);

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Gracefully stopping worker...`);
    try {
      await worker.close();
      console.log('✅ Worker closed cleanly. Exiting.');
      process.exit(0);
    } catch (err) {
      console.error('❌ Error during worker shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startWorker().catch((err) => {
  console.error('❌ Fatal error in worker daemon:', err);
  process.exit(1);
});
