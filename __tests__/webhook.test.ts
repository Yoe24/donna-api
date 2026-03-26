import request from 'supertest';
import express from 'express';

// Mock supabase
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: jest.fn(),
    },
    from: () => ({
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({
            data: { id: 'email-123' },
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

// Mock ai-processor
jest.mock('../src/services/ai-processor', () => ({
  processEmailWithAI: jest.fn().mockResolvedValue(undefined),
}));

// Set required env vars
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.WEBHOOK_SECRET = 'test-secret-123';
process.env.DEFAULT_USER_ID = 'test-user-id';

import webhookRoutes from '../src/routes/webhook';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhook', webhookRoutes);
  return app;
}

describe('Webhook security', () => {
  const app = createApp();

  it('should return 403 when no secret is provided', async () => {
    const res = await request(app)
      .post('/webhook/webhook')
      .send({ subject: 'Test', sender: 'test@test.com', body_text: 'Hello' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Forbidden/i);
  });

  it('should return 403 when wrong secret is provided in header', async () => {
    const res = await request(app)
      .post('/webhook/webhook')
      .set('x-webhook-secret', 'wrong-secret')
      .send({ subject: 'Test', sender: 'test@test.com', body_text: 'Hello' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Forbidden/i);
  });

  it('should return 403 when wrong secret is provided in query', async () => {
    const res = await request(app)
      .post('/webhook/webhook?secret=wrong-secret')
      .send({ subject: 'Test', sender: 'test@test.com', body_text: 'Hello' });

    expect(res.status).toBe(403);
  });

  it('should accept request with correct secret in header', async () => {
    const res = await request(app)
      .post('/webhook/webhook')
      .set('x-webhook-secret', 'test-secret-123')
      .send({ subject: 'Test email', sender: 'test@test.com', body_text: 'Hello' });

    // Should not be 403 (might be 200 or 500 depending on DB mock)
    expect(res.status).not.toBe(403);
  });

  it('should accept request with correct secret in query param', async () => {
    const res = await request(app)
      .post('/webhook/webhook?secret=test-secret-123')
      .send({ subject: 'Test email', sender: 'test@test.com', body_text: 'Hello' });

    expect(res.status).not.toBe(403);
  });

  it('should return 400 when required fields are missing (with valid secret)', async () => {
    const res = await request(app)
      .post('/webhook/webhook')
      .set('x-webhook-secret', 'test-secret-123')
      .send({ body_text: 'Hello' });

    expect(res.status).toBe(400);
  });
});
