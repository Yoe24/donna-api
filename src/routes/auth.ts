/**
 * auth.ts — Authentication routes
 *
 * POST /api/auth/logout
 *   Full user wipe: deletes all user data from DB + Drive folder,
 *   then deletes the configurations row entirely.
 *   Callable by any authenticated user (not restricted to demo whitelist).
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { resetDemoUser } from '../services/demo-reset';
import { supabase } from '../config/supabase';

const router = Router();

// POST /api/auth/logout
router.post('/logout', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    console.log(`[Auth/Logout] Full wipe requested for user ${userId.substring(0, 8)}...`);

    // 1. Fetch refresh_token from configurations before the wipe
    //    (resetDemoUser will read it itself, but we log for diagnostics)
    const { data: cfg } = await supabase
      .from('configurations')
      .select('refresh_token')
      .eq('user_id', userId)
      .single();

    const refreshToken: string | null = cfg?.refresh_token ?? null;

    // 2. Run the full DB + Drive wipe (re-uses demo-reset logic for all users)
    await resetDemoUser(userId, refreshToken);

    // 3. Delete the configurations row entirely (resetDemoUser only NULLs drive_root_folder_id)
    const { error: cfgDeleteErr } = await supabase
      .from('configurations')
      .delete()
      .eq('user_id', userId);

    if (cfgDeleteErr) {
      // Non-blocking: log but don't fail the response
      console.error(`[Auth/Logout] configurations delete error (non-blocking):`, cfgDeleteErr.message);
    } else {
      console.log(`[Auth/Logout] configurations row deleted for user ${userId.substring(0, 8)}`);
    }

    console.log(`[Auth/Logout] Wipe complete for user ${userId.substring(0, 8)}`);
    return res.json({ success: true });
  } catch (err: any) {
    console.error(`[Auth/Logout] Unexpected error:`, err.message);
    // Return success anyway — frontend will signOut regardless
    return res.json({ success: true, warning: 'Partial wipe — some data may remain' });
  }
});

export default router;
