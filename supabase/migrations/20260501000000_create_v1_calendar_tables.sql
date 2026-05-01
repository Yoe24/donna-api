-- V1 Inbox to Legal Calendar — Migration Phase 1
-- Creates 3 isolated tables suffixed _v1 for the new calendar pipeline.
-- Does NOT modify any existing tables (emails, dossiers, etc.)
-- Date: 2026-05-01

CREATE TABLE IF NOT EXISTS messages_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_message_id text NOT NULL,
  thread_id text,
  subject text,
  from_email text,
  from_name text,
  to_emails text[],
  body_text text,
  body_html text,
  date_sent timestamptz,
  ingested_at timestamptz DEFAULT now(),
  UNIQUE(user_id, provider, external_message_id)
);

CREATE TABLE IF NOT EXISTS attachments_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages_v1(id) ON DELETE CASCADE,
  filename text,
  mime_type text,
  size_bytes int,
  storage_url text,
  text_extracted text,
  text_extraction_status text,
  ingested_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events_v1 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  date date NOT NULL,
  time time,
  timezone text DEFAULT 'Europe/Paris',
  title text NOT NULL,
  description text,
  court_or_context text,
  client text,
  counterparty text,
  case_ref text,
  confidence float NOT NULL,
  status text NOT NULL,
  source_message_id uuid REFERENCES messages_v1(id),
  source_attachment_id uuid REFERENCES attachments_v1(id),
  source_type text NOT NULL,
  source_excerpt text,
  dedup_hash text NOT NULL UNIQUE,
  created_at timestamptz DEFAULT now(),
  user_action text,
  user_action_at timestamptz
);

CREATE INDEX IF NOT EXISTS events_v1_user_date ON events_v1(user_id, date);
CREATE INDEX IF NOT EXISTS events_v1_user_status ON events_v1(user_id, status);
