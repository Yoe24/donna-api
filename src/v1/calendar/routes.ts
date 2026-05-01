// V1 Inbox to Calendar — Phase 1 — Routes scaffold (stubs).
// Real implementations come in Phases 2-5.
import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth';

const router = Router();

router.use(authMiddleware);

router.post('/import', async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'stub',
    message: 'Phase 1 OK — awaiting Phase 2 ingest implementation',
    user_id: req.user?.id,
  });
});

router.get('/import/status/:job_id', (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'stub',
    job_id: req.params.job_id,
  });
});

router.get('/events', async (_req: AuthenticatedRequest, res: Response) => {
  res.json({ events: [] });
});

router.patch('/events/:id', async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'stub',
    id: req.params.id,
    action: req.body?.action ?? null,
  });
});

router.get('/events/:id/source', async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    status: 'stub',
    id: req.params.id,
  });
});

export default router;
