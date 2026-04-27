/**
 * src/routes/calendar.ts
 *
 * GET /api/calendar-events
 * Returns calendar events extracted from emails, ordered by date_start ASC.
 *
 * Query params:
 *   since       ISO date (optional, default: now - 30 days)
 *   until       ISO date (optional, default: now + 90 days)
 *   dossier_id  UUID    (optional filter)
 *
 * Auth: same pattern as dossiers.ts — user_id from req.user.id (JWT middleware).
 */

import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// GET /api/calendar-events
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Non authentifié' });

    // Default window: now-30d … now+90d
    const now = new Date();

    const sinceParam = req.query.since as string | undefined;
    const untilParam = req.query.until as string | undefined;
    const dossierIdParam = req.query.dossier_id as string | undefined;

    const since = sinceParam
      ? new Date(sinceParam)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const until = untilParam
      ? new Date(untilParam)
      : new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      return res.status(400).json({ error: 'Paramètre since ou until invalide (format ISO attendu)' });
    }

    let query = supabase
      .from('calendar_events')
      .select('*')
      .eq('user_id', userId)
      .gte('date_start', since.toISOString())
      .lte('date_start', until.toISOString())
      .order('date_start', { ascending: true });

    if (dossierIdParam) {
      query = query.eq('dossier_id', dossierIdParam);
    }

    const { data, error } = await query;

    if (error) {
      console.error('GET /api/calendar-events:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data ?? []);
  } catch (err: any) {
    console.error('GET /api/calendar-events exception:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
