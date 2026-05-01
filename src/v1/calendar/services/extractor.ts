// V1 Inbox to Calendar — Phase 3 — STUB Phase 1
// CLASSIFY (GPT-4o-mini) + EXTRACT (GPT-4o, response_format=json_schema).
// Implementation comes in Phase 3.

import type { ExtractionResult, ClassificationResult } from '../schemas';

export async function classifyMessage(_text: string): Promise<ClassificationResult> {
  throw new Error('classifyMessage not implemented yet (Phase 3)');
}

export async function extractEvents(_text: string): Promise<ExtractionResult> {
  throw new Error('extractEvents not implemented yet (Phase 3)');
}
