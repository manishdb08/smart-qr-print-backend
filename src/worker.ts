import { initTransformationWorker } from './queue/transformationQueue.js';
import { startValidationWorker } from './queue/validationQueue.js';
import { config } from './config/index.js';

async function startWorker() {
  console.log(`⚙️ Starting Smart QR Print Background Worker daemon (ENV: ${config.NODE_ENV})...`);

  const transformWorker = initTransformationWorker();
  const validationWorker = startValidationWorker();

  if (!transformWorker && !validationWorker) {
    console.warn('⚠️ Worker initialization skipped (environment is configured as test or in-process).');
    return;
  }

  console.log(`✅ BullMQ Workers active: 'document-transformations' and 'asset-validation'`);

  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Gracefully stopping workers...`);
    try {
      if (transformWorker) await transformWorker.close();
      if (validationWorker) await validationWorker.close();
      console.log('✅ Workers closed cleanly. Exiting.');
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
