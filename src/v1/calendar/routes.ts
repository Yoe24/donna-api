// V1 Inbox to Calendar — Routes
// Phase 2: /import implemented (Gmail + Outlook ingest).
// Phase 4: /process refactored to async job pattern (fire-and-forget + polling).
//          /process/status/:job_id returns job state.
// Phase 5: other routes remain stubs.

import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth';
import { ingestGmail60d } from './services/ingester.gmail';
import { ingestOutlook60d } from './services/ingester.outlook';
import { processUserMessages, globalJobs, type JobState } from './services/processMessages';

const router = Router();

router.use(authMiddleware);

// POST /api/v1/lab/import
// Body: { provider: 'gmail' | 'outlook' }
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
// Async: returns {job_id, status:'processing'} immediately.
// Pipeline runs in background. Poll /process/status/:job_id for result.
router.post('/process', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const job_id = randomUUID();

  const initialState: JobState = {
    job_id,
    user_id: userId,
    status: 'processing',
    started_at: new Date().toISOString(),
    finished_at: null,
    counts: {
      classified: 0,
      with_actionable: 0,
      events_extracted: 0,
      events_inserted: 0,
      errors: 0,
    },
  };
  globalJobs.set(job_id, initialState);

  // Fire and forget — do not await
  processUserMessages(userId, job_id)
    .then((result) => {
      const j = globalJobs.get(job_id);
      if (j) {
        j.status = 'done';
        j.finished_at = new Date().toISOString();
        j.counts = {
          classified: result.classified,
          with_actionable: result.with_actionable,
          events_extracted: result.events_extracted,
          events_inserted: result.events_inserted,
          errors: result.errors.length,
        };
      }
      console.log(`[v1-process] job ${job_id} done — ${result.events_inserted} events inserted`);
    })
    .catch((err: any) => {
      const j = globalJobs.get(job_id);
      if (j) {
        j.status = 'error';
        j.error_msg = err.message;
        j.finished_at = new Date().toISOString();
      }
      console.error(`[v1-process] job ${job_id} error:`, err);
    });

  return res.json({ job_id, status: 'processing' });
});

// GET /api/v1/lab/process/status/:job_id
// Returns current JobState for the given job_id.
// 404 if job not found (e.g. container restarted — documented tradeoff).
router.get('/process/status/:job_id', (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const j = globalJobs.get(req.params.job_id);
  if (!j) {
    return res.status(404).json({ error: 'job not found (may have expired after container restart)' });
  }

  // Security: only the owner can see the job state
  if (j.user_id !== userId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  return res.json(j);
});

// GET /api/v1/lab/import/status/:job_id — stub (kept for compat)
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
