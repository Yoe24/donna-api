// V1 Inbox to Calendar — Phase 4 helper.
// dedup hash = sha256(event_type + date + (court_or_context||'') + (client||''))
import { createHash } from 'crypto';

export function buildDedupHash(input: {
  event_type: string;
  date: string;
  court_or_context: string | null;
  client: string | null;
}): string {
  const key = [
    input.event_type,
    input.date,
    input.court_or_context ?? '',
    input.client ?? '',
  ].join('|');
  return createHash('sha256').update(key).digest('hex');
}
