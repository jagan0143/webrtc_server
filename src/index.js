import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/error.js';
import authRoutes from './routes/auth.routes.js';
import callRoutes from './routes/call.routes.js';
import configRoutes from './routes/config.routes.js';
import userRoutes from './routes/user.routes.js';
import { closeStaleCalls } from './socket/callHandlers.js';
import { initSocket } from './socket/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'connect-src': ["'self'", 'ws:', 'wss:'],
        // Off so the app also works over plain HTTP on a LAN IP; use HTTPS in production.
        'upgrade-insecure-requests': null,
      },
    },
  })
);
app.use(cors({ origin: env.clientOrigins, credentials: true }));
app.use(express.json({ limit: '20kb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/config', configRoutes);
app.use('/api', notFound);

// In production, serve the built React app from the same origin.
const clientDist = path.resolve(__dirname, '../../webrtc_client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use(errorHandler);

const server = http.createServer(app);
app.set('io', initSocket(server));

async function start() {
  await connectDB();
  await closeStaleCalls();
  server.listen(env.port, () => console.log(`API + signaling on http://localhost:${env.port}`));
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
