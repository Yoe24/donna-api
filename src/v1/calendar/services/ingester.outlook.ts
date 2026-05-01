// V1 Inbox to Calendar — Phase 2 — STUB Phase 1
// Outlook INGEST via Microsoft Graph: fetch 60d, parse body, attachments.
// Implementation comes in Phase 2.

export async function ingestOutlook60d(_userId: string): Promise<{
  messages_count: number;
  attachments_count: number;
}> {
  throw new Error('ingestOutlook60d not implemented yet (Phase 2)');
}
