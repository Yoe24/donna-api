import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

import { testSupabaseConnection } from './config/supabase';
import healthRoutes from './routes/health';
import emailRoutes from './routes/emails';
import importRoutes from './routes/import';
import dossierRoutes from './routes/dossiers';
import configRoutes from './routes/config';
import briefRoutes from './routes/briefs';
import accountRoutes from './routes/account';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import notificationRoutes from './routes/notifications';
import calendarRoutes from './routes/calendar';
import { v1CalendarRouter } from './v1/calendar';
import { authMiddleware } from './middleware/auth';
import { startGmailPolling } from './services/gmail-poller';
import { startDailyBriefingCron } from './services/briefing-cron';
import webhookRoutes from './routes/webhooks';

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
app.use('/webhooks', webhookRoutes); // No auth - Resend needs direct access

// Protected routes (auth required)
app.use('/api/emails', authMiddleware, emailRoutes);
app.use('/api/import', importRoutes);
app.use('/api/dossiers', authMiddleware, dossierRoutes);
app.use('/api/config', authMiddleware, configRoutes);
app.use('/api/briefs', authMiddleware, briefRoutes);
app.use('/api/account', authMiddleware, accountRoutes);
app.use('/api/auth', authMiddleware, authRoutes);
app.use('/api/chat', authMiddleware, chatRoutes);
app.use('/api/notifications', authMiddleware, notificationRoutes);
app.use('/api/calendar-events', authMiddleware, calendarRoutes);

// V1 Inbox to Calendar — isolated pipeline, parallel to existing dossiers.
app.use('/api/v1/lab', v1CalendarRouter);

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

    // Start Gmail polling for all users with refresh tokens
    startGmailPolling().then(() => {
      console.log('Gmail polling started');
    }).catch((err) => {
      console.error('Gmail polling failed to start:', err.message);
    });

    // Start daily briefing email cron (8h00 chaque jour)
    startDailyBriefingCron();
    console.log('Daily briefing cron scheduled (8h00)');
  });
}

startServer();

export { io };
export default app;
