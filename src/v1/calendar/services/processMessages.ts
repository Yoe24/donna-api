// V1 Inbox to Calendar — Phase 4 — Orchestrator
// Chain: CLASSIFY → EXTRACT → NORMALIZE → PERSIST
// Accepts optional job_id to update global job state during processing.

import { supabase } from '../../../config/supabase';
import { classifyMessage, extractEvents } from './extractor';
import { normalizeEvent } from './normalizer';
import { persistEvents } from './persistor';
import type { ExtractedEvent } from '../schemas';

const MAX_ATTACHMENTS_CHARS = 4000;

export interface ProcessResult {
  classified: number;
  with_actionable: number;
  events_extracted: number;
  events_inserted: number;
  errors: string[];
  sample_events: ExtractedEvent[];
}

// ---------------------------------------------------------------------------
// Job tracking — in-memory Map (non-persistent across container restarts).
// Tradeoff: simple V1 solution. If the container restarts, in-flight jobs are
// lost and the client will receive a 404 on status polling. Acceptable for V1
// since jobs complete in ~3 min and container restarts are rare in steady state.
// V2 option: persist job state in a jobs_v1 Supabase table.
// ---------------------------------------------------------------------------
export type JobStatus = 'processing' | 'done' | 'error';

export interface JobState {
  job_id: string;
  user_id: string;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  counts: {
    classified: number;
    with_actionable: number;
    events_extracted: number;
    events_inserted: number;
    errors: number;
  };
  error_msg?: string;
}

export const globalJobs = new Map<string, JobState>();

// ---------------------------------------------------------------------------
// Core orchestration — can be called from route (fire-and-forget) or directly.
// ---------------------------------------------------------------------------
export async function processUserMessages(
  userId: string,
  job_id?: string
): Promise<ProcessResult> {
  const errors: string[] = [];
  let classified = 0;
  let with_actionable = 0;
  let events_extracted = 0;
  let events_inserted = 0;
  const allEvents: ExtractedEvent[] = [];

  // Helper to sync counts to job state during processing
  const syncJobCounts = () => {
    if (!job_id) return;
    const j = globalJobs.get(job_id);
    if (!j) return;
    j.counts = {
      classified,
      with_actionable,
      events_extracted,
      events_inserted,
      errors: errors.length,
    };
  };

  // 1. Fetch all messages for this user
  const { data: messages, error: msgsErr } = await supabase
    .from('messages_v1')
    .select('id, subject, from_email, from_name, date_sent, body_text')
    .eq('user_id', userId)
    .order('date_sent', { ascending: false });

  if (msgsErr) {
    const e = `[processMessages] SELECT messages_v1 error: ${msgsErr.message}`;
    console.error(e);
    errors.push(e);
    return {
      classified: 0,
      with_actionable: 0,
      events_extracted: 0,
      events_inserted: 0,
      errors,
      sample_events: [],
    };
  }

  if (!messages || messages.length === 0) {
    console.warn(`[processMessages] No messages found for user ${userId}`);
    return {
      classified: 0,
      with_actionable: 0,
      events_extracted: 0,
      events_inserted: 0,
      errors,
      sample_events: [],
    };
  }

  console.log(`[processMessages] Processing ${messages.length} messages for user ${userId}`);

  for (const msg of messages) {
    try {
      // 2. Fetch associated attachments with extracted text
      const { data: attachments } = await supabase
        .from('attachments_v1')
        .select('id, text_extracted, filename')
        .eq('message_id', msg.id)
        .eq('text_extraction_status', 'ok')
        .not('text_extracted', 'is', null);

      // 3. Concatenate attachment text (truncated)
      let attachmentsConcat = '';
      // Map attachment text to its id for source tracking
      const attachmentIdByFilename: Record<string, string> = {};

      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (!att.text_extracted) continue;
          const chunk = `[${att.filename ?? 'attachment'}]\n${att.text_extracted}\n\n`;
          if ((attachmentsConcat + chunk).length > MAX_ATTACHMENTS_CHARS) {
            const remaining = MAX_ATTACHMENTS_CHARS - attachmentsConcat.length;
            if (remaining > 50) {
              attachmentsConcat += chunk.substring(0, remaining);
            }
            break;
          }
          attachmentsConcat += chunk;
          if (att.filename) {
            attachmentIdByFilename[att.filename] = att.id;
          }
        }
      }

      // 4. Phase A — CLASSIFY
      const classification = await classifyMessage({
        subject: msg.subject,
        body_text: msg.body_text,
        attachments_text: attachmentsConcat,
      });
      classified++;
      syncJobCounts();

      // Skip if no actionable dates
      if (!classification.has_actionable_dates) {
        continue;
      }
      with_actionable++;

      // 5. Phase B — EXTRACT
      const fromEmail = msg.from_email ?? msg.from_name ?? null;
      const extraction = await extractEvents({
        subject: msg.subject,
        from: fromEmail,
        date_sent: msg.date_sent,
        body_text: msg.body_text,
        attachments_text: attachmentsConcat,
      });

      if (!extraction.events || extraction.events.length === 0) {
        continue;
      }

      events_extracted += extraction.events.length;
      allEvents.push(...extraction.events);

      console.log(
        `[processMessages] msg ${msg.id}: ${extraction.events.length} events extracted (classify: ${classification.doc_type})`
      );

      // 6. Phase C — NORMALIZE + PERSIST
      const normalizedWithSource = extraction.events.map((ev) => {
        const normalized = normalizeEvent(ev);

        // Determine source ids from event source_type
        // If source_type is email_body → source_message_id = msg.id, no attachment
        // If attachment → try to find attachment_id from filename heuristic
        // Note: extractor doesn't return which attachment filename was used,
        // so we use first attachment id if source_type indicates attachment.
        const isAttachment =
          ev.source_type === 'attachment_pdf' || ev.source_type === 'attachment_docx';

        const firstAttachmentId =
          attachments && attachments.length > 0 ? attachments[0].id : null;

        return {
          ...normalized,
          source_message_id: msg.id as string,
          source_attachment_id: isAttachment ? firstAttachmentId : null,
        };
      });

      const persistResult = await persistEvents({
        user_id: userId,
        events: normalizedWithSource,
      });

      events_inserted += persistResult.inserted;
      syncJobCounts();

      console.log(
        `[processMessages] msg ${msg.id}: inserted=${persistResult.inserted} skipped_dedup=${persistResult.skipped_dedup} dropped=${persistResult.dropped_low_conf}`
      );
    } catch (err: any) {
      const e = `[processMessages] error processing message ${msg.id}: ${err.message}`;
      console.error(e);
      errors.push(e);
      syncJobCounts();
    }
  }

  console.log(
    `[processMessages] Done. classified=${classified}, with_actionable=${with_actionable}, events_extracted=${events_extracted}, events_inserted=${events_inserted}, errors=${errors.length}`
  );

  return {
    classified,
    with_actionable,
    events_extracted,
    events_inserted,
    errors,
    sample_events: allEvents.slice(0, 5),
  };
}
