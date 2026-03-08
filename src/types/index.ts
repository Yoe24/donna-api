// Donna MVP Types

export interface Lawyer {
  id: string;
  email: string;
  style: 'formal' | 'casual' | 'direct';
  name?: string;
  created_at: Date;
}

export interface Email {
  id: string;
  from_email: string;
  to_email: string;
  subject: string;
  body: string;
  body_html?: string;
  category?: EmailCategory;
  confidence?: number;
  raw_email?: string;
  created_at: Date;
}

export type EmailCategory = 'pro_action' | 'pro_info' | 'perso' | 'spam';

export interface Draft {
  id: string;
  email_id: string;
  to_email: string;
  subject: string;
  body: string;
  annotations: Annotation[];
  status: DraftStatus;
  created_at: Date;
  updated_at: Date;
}

export type DraftStatus = 'draft' | 'validated' | 'rejected';

export interface Annotation {
  type: 'source' | 'warning' | 'info' | 'deadline';
  text: string;
  confidence?: number;
  severity?: 'low' | 'medium' | 'high';
  ref: string; // [1], [2], [⚠️], etc.
}

export interface DailyStats {
  date: string;
  emails_received: number;
  drafts_created: number;
  drafts_validated: number;
  time_saved_minutes: number;
}

// API Request/Response types
export interface ReceiveEmailRequest {
  from: string;
  to: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  rawEmail?: string;
}

export interface ClassificationResult {
  category: EmailCategory;
  confidence: number;
  reasoning?: string;
}

export interface DraftResult {
  to: string;
  subject: string;
  body: string;
  annotations: Annotation[];
}

// WebSocket events
export interface ServerToClientEvents {
  'email:received': (email: Email) => void;
  'draft:created': (draft: Draft) => void;
  'kpis:update': (stats: DailyStats) => void;
}

export interface ClientToServerEvents {
  'client:ping': () => void;
}
