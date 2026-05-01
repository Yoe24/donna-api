// V1 Inbox to Calendar — Phase 1 — STUB
// Shared TS types for the V1 calendar pipeline.

export type EventType =
  | 'hearing'
  | 'filing_deadline'
  | 'meeting'
  | 'procedural_deadline'
  | 'commercial_deadline'
  | 'unknown';

export type EventStatus = 'auto' | 'to_verify' | 'dismissed';

export type SourceType = 'email_body' | 'attachment_pdf' | 'attachment_docx';

export type Provider = 'gmail' | 'outlook';

export interface MessageV1 {
  id: string;
  user_id: string;
  provider: Provider;
  external_message_id: string;
  thread_id: string | null;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: string[] | null;
  body_text: string | null;
  body_html: string | null;
  date_sent: string | null;
  ingested_at: string;
}

export interface AttachmentV1 {
  id: string;
  message_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  storage_url: string | null;
  text_extracted: string | null;
  text_extraction_status: 'ok' | 'corrupt' | 'unsupported' | null;
  ingested_at: string;
}

export interface EventV1 {
  id: string;
  user_id: string;
  event_type: EventType;
  date: string;
  time: string | null;
  timezone: string;
  title: string;
  description: string | null;
  court_or_context: string | null;
  client: string | null;
  counterparty: string | null;
  case_ref: string | null;
  confidence: number;
  status: EventStatus;
  source_message_id: string | null;
  source_attachment_id: string | null;
  source_type: SourceType;
  source_excerpt: string | null;
  dedup_hash: string;
  created_at: string;
  user_action: 'confirmed' | 'edited' | 'dismissed' | null;
  user_action_at: string | null;
}
