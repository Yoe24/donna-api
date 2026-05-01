// V1 Inbox to Calendar — Phase 3 — Orchestrator
// Reads messages_v1 + attachments_v1 for a given user, runs CLASSIFY then EXTRACT.
// Phase 3 does NOT persist to events_v1 (Phase 4). Returns counters + sample events for debug.

import { supabase } from '../../../config/supabase';
import { classifyMessage, extractEvents } from './extractor';
import type { ExtractedEvent } from '../schemas';

const MAX_ATTACHMENTS_CHARS = 4000;

export async function processUserMessages(userId: string): Promise<{
  classified: number;
  with_actionable: number;
  events_extracted: number;
  errors: string[];
  sample_events: ExtractedEvent[];
}> {
  const errors: string[] = [];
  let classified = 0;
  let with_actionable = 0;
  let events_extracted = 0;
  const allEvents: ExtractedEvent[] = [];

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
    return { classified: 0, with_actionable: 0, events_extracted: 0, errors, sample_events: [] };
  }

  if (!messages || messages.length === 0) {
    console.warn(`[processMessages] No messages found for user ${userId}`);
    return { classified: 0, with_actionable: 0, events_extracted: 0, errors, sample_events: [] };
  }

  console.log(`[processMessages] Processing ${messages.length} messages for user ${userId}`);

  for (const msg of messages) {
    try {
      // 2. Fetch associated attachments with extracted text
      const { data: attachments } = await supabase
        .from('attachments_v1')
        .select('text_extracted, filename')
        .eq('message_id', msg.id)
        .eq('text_extraction_status', 'ok')
        .not('text_extracted', 'is', null);

      // 3. Concatenate attachment text (truncated)
      let attachmentsConcat = '';
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (!att.text_extracted) continue;
          const chunk = `[${att.filename ?? 'attachment'}]\n${att.text_extracted}\n\n`;
          if ((attachmentsConcat + chunk).length > MAX_ATTACHMENTS_CHARS) {
            // Add truncated
            const remaining = MAX_ATTACHMENTS_CHARS - attachmentsConcat.length;
            if (remaining > 50) {
              attachmentsConcat += chunk.substring(0, remaining);
            }
            break;
          }
          attachmentsConcat += chunk;
        }
      }

      // 4. Phase A — CLASSIFY
      const classification = await classifyMessage({
        subject: msg.subject,
        body_text: msg.body_text,
        attachments_text: attachmentsConcat,
      });
      classified++;

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

      if (extraction.events && extraction.events.length > 0) {
        events_extracted += extraction.events.length;
        allEvents.push(...extraction.events);
        console.log(
          `[processMessages] msg ${msg.id}: ${extraction.events.length} events extracted (classify: ${classification.doc_type})`
        );
      }
    } catch (err: any) {
      const e = `[processMessages] error processing message ${msg.id}: ${err.message}`;
      console.error(e);
      errors.push(e);
    }
  }

  console.log(
    `[processMessages] Done. classified=${classified}, with_actionable=${with_actionable}, events_extracted=${events_extracted}, errors=${errors.length}`
  );

  return {
    classified,
    with_actionable,
    events_extracted,
    errors,
    sample_events: allEvents.slice(0, 5),
  };
}
