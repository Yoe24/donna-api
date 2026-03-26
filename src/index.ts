import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

import { testSupabaseConnection } from './config/supabase';
import healthRoutes from './routes/health';
import kpisRoutes from './routes/kpis';
import emailRoutes from './routes/emails';
import { createDraftRoutes } from './routes/drafts';
import importRoutes from './routes/import';
import dossierRoutes from './routes/dossiers';
import configRoutes from './routes/config';
import briefRoutes from './routes/briefs';
import chatRoutes from './routes/chat';
import { authMiddleware } from './middleware/auth';

const app = express();
const httpServer = createServer(app);

// CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')
    : 'http://localhost:5173',
  credentials: true,
};

// Socket.io setup
const io = new Server(httpServer, {
  cors: corsOptions,
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Public routes (no auth)
app.use('/health', healthRoutes);

// Protected routes (auth required)
app.use('/api/kpis', authMiddleware, kpisRoutes);
app.use('/api/emails', authMiddleware, emailRoutes);
app.use('/api/drafts', authMiddleware, createDraftRoutes(io));
app.use('/api/import', importRoutes);
app.use('/api/dossiers', authMiddleware, dossierRoutes);
app.use('/api/config', authMiddleware, configRoutes);
app.use('/api/briefs', authMiddleware, briefRoutes);
app.use('/api/chat', authMiddleware, chatRoutes);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  console.log('Testing Supabase connection...');
  const connected = await testSupabaseConnection();

  if (!connected) {
    console.warn('Supabase not connected. Some features may not work.');
  }

  httpServer.listen(PORT, () => {
    console.log(`Donna MVP server running on port ${PORT}`);
    console.log(`Socket.io ready for real-time updates`);
    console.log(`CORS enabled for: ${corsOptions.origin}`);
  });
}

startServer();

export { io };
export default app;
