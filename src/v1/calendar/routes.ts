// V1 Inbox to Calendar — Routes
// Phase 2: /import implemented (Gmail + Outlook ingest).
// Phase 3: /process implemented (CLASSIFY + EXTRACT, no persistence yet).
// Phase 4-5: other routes remain stubs.
import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth';
import { ingestGmail60d } from './services/ingester.gmail';
import { ingestOutlook60d } from './services/ingester.outlook';
import { processUserMessages } from './services/processMessages';

const router = Router();

router.use(authMiddleware);

// POST /api/v1/lab/import
// Body: { provider: 'gmail' | 'outlook' }
// Auth: user_id from JWT (or ?user_id= fallback via authMiddleware)
router.post('/import', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const provider = req.body?.provider as 'gmail' | 'outlook' | undefined;
  if (!provider || !['gmail', 'outlook'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be gmail or outlook' });
  }

  try {
    const result =
      provider === 'gmail'
        ? await ingestGmail60d(userId)
        : await ingestOutlook60d(userId);
    return res.json({ status: 'ok', provider, ...result });
  } catch (err: any) {
    console.error('[v1-import]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/lab/process
// Runs CLASSIFY + EXTRACT on all messages_v1 for the authenticated user.
// Phase 3: no persistence to events_v1 yet. Returns counters + sample events for debug.
router.post('/process', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const result = await processUserMessages(userId);
    return res.json({ status: 'ok', ...result });
  } catch (err: any) {
    console.error('[v1-process]', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/lab/import/status/:job_id — stub (async jobs Phase 2+)
router.get('/import/status/:job_id', (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'stub',
    job_id: req.params.job_id,
  });
});

// GET /api/v1/lab/events — stub (Phase 5)
router.get('/events', async (_req: AuthenticatedRequest, res: Response) => {
  res.json({ events: [] });
});

// PATCH /api/v1/lab/events/:id — stub (Phase 5)
router.patch('/events/:id', async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'stub',
    id: req.params.id,
    action: req.body?.action ?? null,
  });
});

// GET /api/v1/lab/events/:id/source — stub (Phase 5)
router.get('/events/:id/source', async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'stub',
    id: req.params.id,
  });
});

export default router;
