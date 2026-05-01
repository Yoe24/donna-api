// V1 Inbox to Calendar — Phase 2 — STUB Phase 1
// Gmail INGEST: fetch 60d, parse body HTML→text, download+extract attachments.
// Implementation comes in Phase 2.

export async function ingestGmail60d(_userId: string): Promise<{
  messages_count: number;
  attachments_count: number;
}> {
  throw new Error('ingestGmail60d not implemented yet (Phase 2)');
}
