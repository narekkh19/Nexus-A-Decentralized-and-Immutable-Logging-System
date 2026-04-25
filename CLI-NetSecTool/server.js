import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import logger from './services/loggingService.js';
import configService from './services/configService.js';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function createApp() {
  const app = express();
  const config = await configService.get();

  // Basic middleware
  app.use(express.json());

  // CORS configuration
  if (config.server.cors.enabled) {
    app.use(cors({
      origin: config.server.cors.origins,
      methods: config.server.cors.methods
    }));
  }

  // Rate limiting
  if (config.server.rate_limit.enabled) {
    const rateLimit = (await import('express-rate-limit')).default;
    app.use(rateLimit({
      windowMs: config.server.rate_limit.window_ms,
      max: config.server.rate_limit.max_requests
    }));
  }

  // Static files (disable cache to avoid stale UI script/state during demos)
  app.use(express.static(path.join(__dirname, config.server.static_dir), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('main.js') || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    }
  }));

  // API routes
  app.use(config.server.api_prefix, (await import('./routes/api.js')).default);

  // Error handler
  app.use((err, _req, res, _next) => {
    logger.error(err.message, { stack: err.stack });
    res.status(500).json({ success: false, error: err.message });
  });

  return app;
}

async function startServer() {
  const app = await createApp();
  const config = await configService.get('server');
  
  const server = app.listen(config.port, config.host, () => {
    logger.info(`Web UI: http://${config.host}:${config.port}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });

  return server;
}

export { startServer };

// If executed directly (node server.js) start immediately
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch(err => {
    logger.error('Failed to start server:', err);
    process.exit(1);
  });
} 