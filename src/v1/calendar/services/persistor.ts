// V1 Inbox to Calendar — Phase 4 — PERSIST
// Upsert normalized events into events_v1.
// Filters out 'dismissed' events (confidence < 0.6) before insert.
// Idempotence: ON CONFLICT (dedup_hash) DO NOTHING — safe to run multiple times.

import { supabase } from '../../../config/supabase';
import type { NormalizedEvent } from './normalizer';

export interface PersistInput {
  user_id: string;
  events: Array<
    NormalizedEvent & {
      source_message_id: string | null;
      source_attachment_id: string | null;
    }
  >;
}

export interface PersistResult {
  inserted: number;
  skipped_dedup: number;
  dropped_low_conf: number;
}

export async function persistEvents(input: PersistInput): Promise<PersistResult> {
  const { user_id, events } = input;

  // 1. Separate dismissed from insertable
  const dismissed = events.filter((e) => e.status === 'dismissed');
  const insertable = events.filter((e) => e.status !== 'dismissed');

  const dropped_low_conf = dismissed.length;

  if (insertable.length === 0) {
    return { inserted: 0, skipped_dedup: 0, dropped_low_conf };
  }

  // 2. Build rows for Supabase insert
  const rows = insertable.map((e) => ({
    user_id,
    event_type: e.event_type,
    date: e.date,
    time: e.time ?? null,
    timezone: e.timezone,
    title: e.title,
    description: e.description ?? null,
    court_or_context: e.court_or_context ?? null,
    client: e.client ?? null,
    counterparty: e.counterparty ?? null,
    case_ref: e.case_ref ?? null,
    confidence: e.confidence,
    status: e.status,
    source_message_id: e.source_message_id ?? null,
    source_attachment_id: e.source_attachment_id ?? null,
    source_type: e.source_type,
    source_excerpt: e.source_excerpt ?? null,
    dedup_hash: e.dedup_hash,
  }));

  // 3. Upsert with ON CONFLICT (dedup_hash) DO NOTHING
  // Supabase JS v2: ignoreDuplicates:true uses ON CONFLICT DO NOTHING
  const { data, error } = await supabase
    .from('events_v1')
    .upsert(rows, { onConflict: 'dedup_hash', ignoreDuplicates: true })
    .select('id');

  if (error) {
    throw new Error(`[persistor] upsert events_v1 failed: ${error.message}`);
  }

  const inserted = data ? data.length : 0;
  // rows that were ignored by DO NOTHING don't appear in select result
  const skipped_dedup = insertable.length - inserted;

  return { inserted, skipped_dedup, dropped_low_conf };
}
