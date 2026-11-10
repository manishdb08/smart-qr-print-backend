import { buildApp } from './app.js';
import { config } from './config/index.js';

async function startServer() {
  let targetPort = config.PORT;
  const app = await buildApp();

  try {
    await app.listen({
      port: targetPort,
      host: config.HOST,
    });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      targetPort = config.PORT + 1;
      console.warn(`⚠️ Port ${config.PORT} is already in use by another process. Automatically falling back to port ${targetPort}...`);
      try {
        await app.listen({
          port: targetPort,
          host: config.HOST,
        });
      } catch (fallbackErr) {
        console.error(`❌ Failed to start server on fallback port ${targetPort}:`, fallbackErr);
        process.exit(1);
      }
    } else {
      console.error('❌ Failed to start server:', err);
      process.exit(1);
    }
  }

  const hostDisplay = config.HOST === '0.0.0.0' ? 'localhost' : config.HOST;
  console.log(`🚀 Smart QR Print Server running at http://${hostDisplay}:${targetPort}`);
  console.log(`📖 OpenAPI Swagger docs available at http://${hostDisplay}:${targetPort}/docs`);
  console.log(`🩺 Healthcheck: http://${hostDisplay}:${targetPort}/health`);
}

startServer();
