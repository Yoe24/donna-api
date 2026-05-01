// V1 Inbox to Calendar — Phase 4 — NORMALIZE + DEDUPE
// Canonical rules:
//   - Default timezone if null/empty
//   - Compute dedup_hash via buildDedupHash
//   - Compute status from confidence + event_type thresholds
//   - status='dismissed' ← confidence < 0.6 (persistor will filter these out)

import type { ExtractedEvent } from '../schemas';
import { buildDedupHash } from '../utils/dedup';

export interface NormalizedEvent extends ExtractedEvent {
  dedup_hash: string;
  status: 'auto' | 'to_verify' | 'dismissed';
}

export function normalizeEvent(event: ExtractedEvent): NormalizedEvent {
  // 1. Default timezone if null or empty
  const timezone =
    event.timezone && event.timezone.trim().length > 0
      ? event.timezone.trim()
      : 'Europe/Paris';

  // 2. Compute dedup hash
  const dedup_hash = buildDedupHash({
    event_type: event.event_type,
    date: event.date,
    court_or_context: event.court_or_context,
    client: event.client,
  });

  // 3. Compute status
  //   confidence >= 0.85 AND event_type != 'unknown' → 'auto'
  //   0.6 <= confidence < 0.85 OR event_type == 'unknown' → 'to_verify'
  //   confidence < 0.6 → 'dismissed'
  let status: 'auto' | 'to_verify' | 'dismissed';

  if (event.confidence < 0.6) {
    status = 'dismissed';
  } else if (event.confidence >= 0.85 && event.event_type !== 'unknown') {
    status = 'auto';
  } else {
    // 0.6 <= conf < 0.85 OR event_type == 'unknown'
    status = 'to_verify';
  }

  return {
    ...event,
    timezone,
    dedup_hash,
    status,
  };
}
