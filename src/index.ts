import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

import webhookRoutes from './routes/webhook';
import { testSupabaseConnection } from './config/supabase';
import healthRoutes from './routes/health';
import kpisRoutes from './routes/kpis';
import { createEmailRoutes } from './routes/emails';
import { createDraftRoutes } from './routes/drafts';
import { authMiddleware } from './middleware/auth';

const app = express();
const httpServer = createServer(app);

// CORS configuration - Allow AgentMail webhook
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
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
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Public routes (no auth)
app.use('/health', healthRoutes);
app.use('/webhook', webhookRoutes);

// Protected routes (auth required)
app.use('/api/kpis', authMiddleware, kpisRoutes);
app.use('/api/emails', authMiddleware, createEmailRoutes(io));
app.use('/api/drafts', authMiddleware, createDraftRoutes(io));

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

// Test Supabase connection on startup
async function startServer() {
  console.log('🔌 Testing Supabase connection...');
  const connected = await testSupabaseConnection();
  
  if (!connected) {
    console.warn('⚠️  Supabase not connected. Some features may not work.');
  }

  httpServer.listen(PORT, () => {
    console.log(`🚀 Donna MVP server running on port ${PORT}`);
    console.log(`📡 Socket.io ready for real-time updates`);
    console.log(`🌐 CORS enabled for: ${corsOptions.origin}`);
    console.log(`📨 Webhook endpoint: POST http://localhost:${PORT}/webhook/webhook`);
  });
}

startServer();

export { io };
export default app;
