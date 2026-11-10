/**
 * PM2 Process Manager Configuration (Production & Non-Docker Environments)
 * Runs API server and background BullMQ worker with daemonization, auto-restart, and log management.
 */
module.exports = {
  apps: [
    {
      name: 'smart-qr-api',
      script: 'dist/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      time: true,
      env: {
        NODE_ENV: 'development',
        PORT: 5000,
        HOST: '0.0.0.0',
      },
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      merge_logs: true,
    },
    {
      name: 'smart-qr-worker',
      script: 'dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      time: true,
      env: {
        NODE_ENV: 'development',
      },
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      merge_logs: true,
    },
  ],
};
