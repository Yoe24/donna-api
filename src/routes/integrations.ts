/**
 * /api/integrations — Enable / disable OneDrive and Outlook Calendar sync.
 *
 * All endpoints are protected by authMiddleware (req.user.id).
 *
 * POST /api/integrations/onedrive/enable
 * POST /api/integrations/onedrive/disable
 * POST /api/integrations/outlook-calendar/enable
 * POST /api/integrations/outlook-calendar/disable
 * GET  /api/integrations/status
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { supabase } from '../config/supabase';
import { triggerOneDriveExport } from '../services/onedrive-exporter';
import { triggerOutlookCalendarExport } from '../services/outlook-calendar-exporter';

const router = Router();

// ─── OneDrive ─────────────────────────────────────────────────────────────────

router.post('/onedrive/enable', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const { error } = await supabase
      .from('configurations')
      .update({ onedrive_sync_enabled: true })
      .eq('user_id', userId);

    if (error) {
      console.error('[integrations] onedrive/enable update error:', error.message);
      return res.status(500).json({ error: 'DB update failed', details: error.message });
    }

    // Trigger export immediately (fire-and-forget)
    triggerOneDriveExport(userId).catch((e: any) =>
      console.error('[integrations] triggerOneDriveExport error:', e.message)
    );

    return res.json({ onedrive_sync_enabled: true, message: 'OneDrive sync enabled — export started' });
  } catch (e: any) {
    console.error('[integrations] onedrive/enable error:', e.message);
    return res.status(500).json({ error: 'Internal error', details: e.message });
  }
});

router.post('/onedrive/disable', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const { error } = await supabase
      .from('configurations')
      .update({ onedrive_sync_enabled: false })
      .eq('user_id', userId);

    if (error) {
      return res.status(500).json({ error: 'DB update failed', details: error.message });
    }

    return res.json({ onedrive_sync_enabled: false });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal error', details: e.message });
  }
});

// ─── Outlook Calendar ─────────────────────────────────────────────────────────

router.post('/outlook-calendar/enable', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const { error } = await supabase
      .from('configurations')
      .update({ outlook_calendar_sync_enabled: true })
      .eq('user_id', userId);

    if (error) {
      return res.status(500).json({ error: 'DB update failed', details: error.message });
    }

    // Trigger sync immediately (fire-and-forget)
    triggerOutlookCalendarExport(userId).catch((e: any) =>
      console.error('[integrations] triggerOutlookCalendarExport error:', e.message)
    );

    return res.json({ outlook_calendar_sync_enabled: true, message: 'Outlook Calendar sync enabled — export started' });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal error', details: e.message });
  }
});

router.post('/outlook-calendar/disable', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const { error } = await supabase
      .from('configurations')
      .update({ outlook_calendar_sync_enabled: false })
      .eq('user_id', userId);

    if (error) {
      return res.status(500).json({ error: 'DB update failed', details: error.message });
    }

    return res.json({ outlook_calendar_sync_enabled: false });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal error', details: e.message });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────

router.get('/status', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const { data: cfg, error } = await supabase
      .from('configurations')
      .select('provider, drive_sync_enabled, onedrive_sync_enabled, outlook_calendar_sync_enabled, onedrive_root_folder_id')
      .eq('user_id', userId)
      .single();

    if (error || !cfg) {
      return res.status(404).json({ error: 'Config not found' });
    }

    return res.json({
      google_drive: cfg.drive_sync_enabled ?? false,
      onedrive: cfg.onedrive_sync_enabled ?? false,
      onedrive_root_folder_id: cfg.onedrive_root_folder_id ?? null,
      outlook_calendar: cfg.outlook_calendar_sync_enabled ?? false,
      gmail_calendar: false, // not implemented
      provider: cfg.provider ?? 'gmail',
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'Internal error', details: e.message });
  }
});

export default router;
