// V1 Inbox to Calendar — Phase 1 — Zod schemas for LLM JSON validation (used Phase 3).
import { z } from 'zod';

export const EventTypeSchema = z.enum([
  'hearing',
  'filing_deadline',
  'meeting',
  'procedural_deadline',
  'commercial_deadline',
  'unknown',
]);

export const SourceTypeSchema = z.enum([
  'email_body',
  'attachment_pdf',
  'attachment_docx',
]);

export const ExtractedEventSchema = z.object({
  event_type: EventTypeSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM').nullable(),
  timezone: z.string().nullable().default('Europe/Paris'),
  title: z.string().max(80),
  description: z.string().max(200),
  court_or_context: z.string().nullable(),
  client: z.string().nullable(),
  counterparty: z.string().nullable(),
  case_ref: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  source_type: SourceTypeSchema,
  source_excerpt: z.string().max(300),
});

export const ExtractionResultSchema = z.object({
  events: z.array(ExtractedEventSchema),
});

export const ClassificationResultSchema = z.object({
  has_actionable_dates: z.boolean(),
  doc_type: z.enum([
    'email_procedural',
    'contract',
    'meeting_request',
    'informational',
    'other',
  ]),
  rough_count: z.number().int().min(0),
});

export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;
