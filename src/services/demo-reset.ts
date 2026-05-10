/**
 * demo-reset.ts — Hard reset for whitelisted demo users.
 *
 * Purges all user data from DB + the "Donna" root folder from Google Drive,
 * then resets configurations.drive_root_folder_id to NULL.
 *
 * SAFETY: only runs if the user's email is in DEMO_RESET_USERS env var.
 * If that env var is empty or undefined, this is a no-op for every user.
 */

import { google } from 'googleapis';
import { supabase } from '../config/supabase';

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Returns the whitelist of demo emails (trimmed, lowercase).
 * Source: DEMO_RESET_USERS env var, comma-separated.
 */
function getDemoWhitelist(): string[] {
  const raw = process.env.DEMO_RESET_USERS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Returns true if the given email is in the whitelist. */
export function isDemoResetUser(email: string): boolean {
  const whitelist = getDemoWhitelist();
  if (whitelist.length === 0) return false;
  return whitelist.includes(email.trim().toLowerCase());
}

// ─── Drive reset ──────────────────────────────────────────────────────────────

async function deleteDriveRootFolder(
  refreshToken: string,
  rootFolderId: string,
): Promise<void> {
  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth });

    await drive.files.delete({ fileId: rootFolderId });
    console.log(`[DemoReset] Drive root folder deleted: ${rootFolderId}`);
  } catch (e: any) {
    // 404 = already gone, that's fine
    if (e?.code === 404 || e?.status === 404) {
      console.log(`[DemoReset] Drive root folder ${rootFolderId} already gone — continuing`);
    } else {
      console.error(`[DemoReset] Drive delete error (non-blocking):`, e.message);
    }
  }
}

// ─── DB reset ────────────────────────────────────────────────────────────────

async function resetDatabase(userId: string): Promise<{
  dossiers: number;
  emails: number;
  events: number;
  attachments: number;
}> {
  const counts = { dossiers: 0, emails: 0, events: 0, attachments: 0 };

  try {
    // 1. events_v1
    const { count: evCount, error: evErr } = await supabase
      .from('events_v1')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    if (evErr) console.error('[DemoReset] events_v1 delete error:', evErr.message);
    else counts.events = evCount ?? 0;

    // 2. attachments via messages (events_v1 table style — adjust if schema differs)
    // Try attachments_v1 if it exists (v1 pipeline)
    const { count: attCount, error: attErr } = await supabase
      .from('attachments_v1')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    if (attErr) {
      // Table may not exist — silent ignore
      if (!attErr.message.includes('does not exist')) {
        console.error('[DemoReset] attachments_v1 delete error:', attErr.message);
      }
    } else {
      counts.attachments += attCount ?? 0;
    }

    // 3. messages_v1
    const { error: msgErr } = await supabase
      .from('messages_v1')
      .delete()
      .eq('user_id', userId);
    if (msgErr && !msgErr.message.includes('does not exist')) {
      console.error('[DemoReset] messages_v1 delete error:', msgErr.message);
    }

    // 4. dossier_documents (cascade from dossiers)
    const { data: dossierIds } = await supabase
      .from('dossiers')
      .select('id')
      .eq('user_id', userId);
    const ids = (dossierIds || []).map((d: any) => d.id);

    if (ids.length > 0) {
      const { count: docCount, error: docErr } = await supabase
        .from('dossier_documents')
        .delete({ count: 'exact' })
        .in('dossier_id', ids);
      if (docErr) console.error('[DemoReset] dossier_documents delete error:', docErr.message);
      else counts.attachments += docCount ?? 0;
    }

    // 5. emails
    const { count: emCount, error: emErr } = await supabase
      .from('emails')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    if (emErr) console.error('[DemoReset] emails delete error:', emErr.message);
    else counts.emails = emCount ?? 0;

    // 6. dossiers
    const { count: dosCount, error: dosErr } = await supabase
      .from('dossiers')
      .delete({ count: 'exact' })
      .eq('user_id', userId);
    if (dosErr) console.error('[DemoReset] dossiers delete error:', dosErr.message);
    else counts.dossiers = dosCount ?? 0;

    // 7. briefs
    const { error: briefErr } = await supabase
      .from('briefs')
      .delete()
      .eq('user_id', userId);
    if (briefErr) console.error('[DemoReset] briefs delete error:', briefErr.message);

    // 8. Reset drive_root_folder_id (keep refresh_token, keep the rest)
    const { error: cfgErr } = await supabase
      .from('configurations')
      .update({ drive_root_folder_id: null })
      .eq('user_id', userId);
    if (cfgErr) console.error('[DemoReset] config update error:', cfgErr.message);

  } catch (e: any) {
    console.error('[DemoReset] resetDatabase unexpected error:', e.message);
  }

  return counts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Full reset for a demo user.
 * 1. Read drive_root_folder_id from DB
 * 2. Delete Drive folder (cascade on sub-folders + files)
 * 3. Delete all DB data for the user
 * 4. Reset configurations.drive_root_folder_id = NULL
 *
 * Safe: if Drive delete fails (404, no token), continues to DB reset.
 */
export async function resetDemoUser(userId: string, refreshToken?: string | null): Promise<void> {
  console.log(`[DemoReset] Starting reset for user ${userId.substring(0, 8)}...`);

  // 1. Fetch current drive_root_folder_id (before wiping DB)
  const { data: cfg } = await supabase
    .from('configurations')
    .select('drive_root_folder_id, refresh_token')
    .eq('user_id', userId)
    .single();

  const driveFolderId: string | null = cfg?.drive_root_folder_id ?? null;
  const token: string | null = refreshToken || cfg?.refresh_token || null;

  // 2. Delete Drive folder first (needs drive_root_folder_id from DB)
  if (driveFolderId && token) {
    await deleteDriveRootFolder(token, driveFolderId);
  } else {
    console.log(`[DemoReset] No Drive folder to delete (folderId=${driveFolderId}, hasToken=${!!token})`);
  }

  // 3. Reset DB
  const counts = await resetDatabase(userId);

  console.log(
    `[DemoReset] User ${userId.substring(0, 8)} reset complete: ` +
    `deleted ${counts.dossiers} dossiers, ${counts.emails} emails, ` +
    `${counts.events} events, ${counts.attachments} attachments, ` +
    `Drive folder ${driveFolderId || 'N/A'} purged`,
  );
}
