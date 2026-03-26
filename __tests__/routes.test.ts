import request from 'supertest';
import express from 'express';

// Mock supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: jest.fn().mockResolvedValue({
        data: { user: null },
        error: { message: 'Invalid token' },
      }),
    },
    from: () => ({
      select: () => ({
        limit: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
  }),
}));

// Set required env vars
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.WEBHOOK_SECRET = 'test-webhook-secret';

import healthRoutes from '../src/routes/health';
import { authMiddleware } from '../src/middleware/auth';

// Create a minimal app for testing
function createApp() {
  const app = express();
  app.use(express.json());

  // Public routes
  app.use('/health', healthRoutes);

  // Protected routes (minimal stubs that would normally be full routers)
  app.get('/api/emails', authMiddleware, (_req, res) => res.json([]));
  app.get('/api/kpis', authMiddleware, (_req, res) => res.json({}));
  app.get('/api/drafts', authMiddleware, (_req, res) => res.json([]));
  app.get('/api/dossiers', authMiddleware, (_req, res) => res.json([]));
  app.get('/api/config', authMiddleware, (_req, res) => res.json({}));
  app.get('/api/briefs/today', authMiddleware, (_req, res) => res.json({}));
  app.post('/api/chat', authMiddleware, (_req, res) => res.json({}));

  return app;
}

describe('Route protection', () => {
  const app = createApp();

  it('GET /health should return 200 without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  const protectedRoutes = [
    ['GET', '/api/emails'],
    ['GET', '/api/kpis'],
    ['GET', '/api/drafts'],
    ['GET', '/api/dossiers'],
    ['GET', '/api/config'],
    ['GET', '/api/briefs/today'],
    ['POST', '/api/chat'],
  ];

  protectedRoutes.forEach(([method, path]) => {
    it(`${method} ${path} should return 401 without auth`, async () => {
      const req = method === 'POST'
        ? request(app).post(path).send({})
        : request(app).get(path);

      const res = await req;
      expect(res.status).toBe(401);
    });
  });
});
