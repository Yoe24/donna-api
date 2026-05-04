// V1 Inbox to Calendar — Routes
// Phase 2: /import implemented (Gmail + Outlook ingest).
// Phase 4: /process refactored to async job pattern (fire-and-forget + polling).
//          /process/status/:job_id returns job state.
// Phase 5: GET /events, PATCH /events/:id, GET /events/:id/source implemented.
// Phase 6: POST /reset — purge _v1 tables for test loops. ?reset=1 on /import and /process.

import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth';
import { ingestGmail60d } from './services/ingester.gmail';
import { ingestOutlook60d } from './services/ingester.outlook';
import { processUserMessages, globalJobs, type JobState } from './services/processMessages';
import { supabase } from '../../config/supabase';

// ─── Helper: purge _v1 tables for a given user ────────────────────────────────
// Order matters: events_v1.source_message_id references messages_v1.id (no CASCADE),
// so delete events first. attachments_v1.message_id has ON DELETE CASCADE from messages_v1,
// but we delete explicitly to get the count.
async function purgeV1Tables(userId: string): Promise<{
  deleted_events: number;
  deleted_attachments: number;
  deleted_messages: number;
}> {
  // 1. Delete events_v1 first (no FK cascade to messages_v1)
  const { data: evData, error: evErr } = await supabase
    .from('events_v1')
    .delete()
    .eq('user_id', userId)
    .select('id');
  if (evErr) throw new Error(`purge events_v1: ${evErr.message}`);

  // 2. Delete attachments_v1 via message_id IN (messages belonging to user)
  const { data: attData, error: attErr } = await supabase
    .from('attachments_v1')
    .delete()
    .in(
      'message_id',
      // sub-select: get message ids for this user
      (
        await supabase.from('messages_v1').select('id').eq('user_id', userId)
      ).data?.map((r: { id: string }) => r.id) ?? []
    )
    .select('id');
  if (attErr) throw new Error(`purge attachments_v1: ${attErr.message}`);

  // 3. Delete messages_v1
  const { data: msgData, error: msgErr } = await supabase
    .from('messages_v1')
    .delete()
    .eq('user_id', userId)
    .select('id');
  if (msgErr) throw new Error(`purge messages_v1: ${msgErr.message}`);

  return {
    deleted_events: evData?.length ?? 0,
    deleted_attachments: attData?.length ?? 0,
    deleted_messages: msgData?.length ?? 0,
  };
}

const router = Router();

router.use(authMiddleware);

// POST /api/v1/lab/reset
// Purges events_v1 / attachments_v1 / messages_v1 for the authenticated user.
// Returns counts of deleted rows. No ingest is triggered.
router.post('/reset', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  try {
    const counts = await purgeV1Tables(userId);
    console.log(`[v1-reset] user=${userId} purged: events=${counts.deleted_events} attachments=${counts.deleted_attachments} messages=${counts.deleted_messages}`);
    return res.json(counts);
  } catch (err: any) {
    console.error('[v1-reset]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/lab/import
// Body: { provider: 'gmail' | 'outlook', reset?: boolean }
// Query: ?reset=1 also triggers purge before ingest.
router.post('/import', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const provider = req.body?.provider as 'gmail' | 'outlook' | undefined;
  if (!provider || !['gmail', 'outlook'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be gmail or outlook' });
  }

  // reset=1 in query OR reset: true in body
  const shouldReset = req.query.reset === '1' || req.body?.reset === true;

  try {
    let resetCounts: Awaited<ReturnType<typeof purgeV1Tables>> | null = null;
    if (shouldReset) {
      resetCounts = await purgeV1Tables(userId);
      console.log(`[v1-import] reset before ingest — user=${userId} events=${resetCounts.deleted_events} msgs=${resetCounts.deleted_messages}`);
    }

    const result =
      provider === 'gmail'
        ? await ingestGmail60d(userId)
        : await ingestOutlook60d(userId);
    return res.json({ status: 'ok', provider, reset: resetCounts, ...result });
  } catch (err: any) {
    console.error('[v1-import]', err);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/lab/process
// Async: returns {job_id, status:'processing'} immediately.
// Pipeline runs in background. Poll /process/status/:job_id for result.
// Query: ?reset=1 OR body: { reset: true } to purge _v1 tables before processing.
router.post('/process', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  // reset=1 in query OR reset: true in body
  const shouldReset = req.query.reset === '1' || req.body?.reset === true;

  try {
    if (shouldReset) {
      const counts = await purgeV1Tables(userId);
      console.log(`[v1-process] reset before process — user=${userId} events=${counts.deleted_events} msgs=${counts.deleted_messages}`);
    }
  } catch (err: any) {
    console.error('[v1-process] reset failed:', err);
    return res.status(500).json({ error: `reset failed: ${err.message}` });
  }

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

// GET /api/v1/lab/events — Phase 5
// Query params: from, to, status (auto|to_verify|all), type, count_only
router.get('/events', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const today = new Date().toISOString().slice(0, 10);
  const defaultTo = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const from = (req.query.from as string) || today;
  const to = (req.query.to as string) || defaultTo;
  const statusParam = (req.query.status as string) || 'all';
  const typeParam = req.query.type as string | undefined;
  const countOnly = req.query.count_only === 'true';

  try {
    let query = supabase
      .from('events_v1')
      .select(
        'id, event_type, date, time, timezone, title, description, court_or_context, client, counterparty, case_ref, confidence, status, source_message_id, source_attachment_id, source_type, source_excerpt, user_action, created_at'
      )
      .eq('user_id', userId)
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true })
      .order('time', { ascending: true, nullsFirst: false });

    // Status filter: default 'all' excludes dismissed; 'all' means auto + to_verify
    if (statusParam === 'auto') {
      query = query.eq('status', 'auto');
    } else if (statusParam === 'to_verify') {
      query = query.eq('status', 'to_verify');
    } else {
      // 'all' = auto + to_verify (not dismissed)
      query = query.in('status', ['auto', 'to_verify']);
    }

    if (typeParam) {
      query = query.eq('event_type', typeParam);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[v1-events] query error:', error);
      return res.status(500).json({ error: error.message });
    }

    const events = data ?? [];

    if (countOnly) {
      return res.json({ count: events.length });
    }

    return res.json({ events, count: events.length });
  } catch (err: any) {
    console.error('[v1-events]', err);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/v1/lab/events/:id — Phase 5
// Body: { action: 'confirm'|'edit'|'dismiss', edits?: { title?, date?, time?, ... } }
router.patch('/events/:id', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { id } = req.params;
  const { action, edits } = req.body ?? {};

  if (!action || !['confirm', 'edit', 'dismiss'].includes(action)) {
    return res.status(400).json({ error: 'action must be confirm, edit, or dismiss' });
  }

  try {
    // Verify event belongs to user
    const { data: existing, error: fetchErr } = await supabase
      .from('events_v1')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'event not found' });
    }

    let updatePayload: Record<string, unknown> = {
      user_action_at: new Date().toISOString(),
    };

    if (action === 'confirm') {
      updatePayload.user_action = 'confirmed';
    } else if (action === 'dismiss') {
      updatePayload.user_action = 'dismissed';
    } else if (action === 'edit') {
      updatePayload.user_action = 'edited';
      // Apply allowed field edits (no dedup_hash recalc to avoid phantom duplicates)
      const allowed = ['title', 'date', 'time', 'description', 'court_or_context', 'client', 'counterparty', 'case_ref', 'event_type'];
      if (edits && typeof edits === 'object') {
        for (const key of allowed) {
          if (key in edits) {
            updatePayload[key] = (edits as Record<string, unknown>)[key];
          }
        }
      }
    }

    const { error: updateErr } = await supabase
      .from('events_v1')
      .update(updatePayload)
      .eq('id', id)
      .eq('user_id', userId);

    if (updateErr) {
      return res.status(500).json({ error: updateErr.message });
    }

    return res.json({ ok: true, id, action });
  } catch (err: any) {
    console.error('[v1-events-patch]', err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/lab/events/:id/source — Phase 5
// Returns link to original email thread or signed URL for attachment
router.get('/events/:id/source', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const { id } = req.params;

  try {
    // Fetch event
    const { data: event, error: eventErr } = await supabase
      .from('events_v1')
      .select('id, source_type, source_message_id, source_attachment_id, source_excerpt')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (eventErr || !event) {
      return res.status(404).json({ error: 'event not found' });
    }

    const result: Record<string, unknown> = {
      source_excerpt: event.source_excerpt,
    };

    // Case 1: email body → return Gmail thread URL
    if (event.source_type === 'email_body' && event.source_message_id) {
      const { data: msg, error: msgErr } = await supabase
        .from('messages_v1')
        .select('thread_id, subject, provider')
        .eq('id', event.source_message_id)
        .single();

      if (msgErr || !msg) {
        result.kind = 'email';
        result.gmail_thread_url = null;
        result.subject = null;
      } else {
        result.kind = 'email';
        result.subject = msg.subject;
        if (msg.provider === 'gmail' && msg.thread_id) {
          // Lookup the user's email to use ?authuser= which forces Gmail to open
          // the right account when the user has multiple Google accounts logged in.
          const { data: userData } = await supabase.auth.admin.getUserById(userId);
          const userEmail = userData?.user?.email;
          const base = userEmail
            ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(userEmail)}`
            : 'https://mail.google.com/mail/u/0';
          result.gmail_thread_url = `${base}#all/${msg.thread_id}`;
        } else if (msg.provider === 'outlook') {
          // Outlook deep-link not available in V1
          result.gmail_thread_url = null;
          result.outlook_note = 'Outlook deep-link not yet implemented';
        } else {
          result.gmail_thread_url = null;
        }
      }
      return res.json(result);
    }

    // Case 2: attachment → return signed URL from Supabase Storage
    if (event.source_type && event.source_type.startsWith('attachment_') && event.source_attachment_id) {
      const { data: att, error: attErr } = await supabase
        .from('attachments_v1')
        .select('filename, storage_url, mime_type')
        .eq('id', event.source_attachment_id)
        .single();

      if (attErr || !att) {
        result.kind = 'attachment';
        result.signed_url = null;
        return res.json(result);
      }

      // storage_url can be a full URL or just a path — extract path
      let storagePath = att.storage_url ?? '';
      // If it's a full supabase URL, extract just the path after the bucket name
      const bucketName = 'v1-attachments';
      const bucketMarker = `/object/public/${bucketName}/`;
      if (storagePath.includes(bucketMarker)) {
        storagePath = storagePath.split(bucketMarker)[1];
      }
      // If it starts with https but without our marker, use as-is (will likely fail signing)
      if (storagePath.startsWith('https://')) {
        result.kind = 'attachment';
        result.filename = att.filename;
        result.mime_type = att.mime_type;
        result.signed_url = storagePath; // fallback: return raw URL
        return res.json(result);
      }

      const { data: signed, error: signErr } = await supabase.storage
        .from(bucketName)
        .createSignedUrl(storagePath, 3600);

      result.kind = 'attachment';
      result.filename = att.filename;
      result.mime_type = att.mime_type;

      if (signErr || !signed) {
        result.signed_url = null;
        result.error = signErr?.message ?? 'could not sign URL';
      } else {
        result.signed_url = signed.signedUrl;
      }

      return res.json(result);
    }

    // Fallback: no source resolvable
    return res.json({ kind: 'unknown', source_excerpt: event.source_excerpt });
  } catch (err: any) {
    console.error('[v1-events-source]', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
