// V1 Inbox to Calendar — Phase 3 — CLASSIFY (GPT-4o-mini) + EXTRACT (GPT-4o)
// Implements LLM-based event extraction with strict Zod validation + 1-retry on parse error.

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import {
  ExtractionResultSchema,
  ClassificationResultSchema,
  ExtractionResult,
  ClassificationResult,
} from '../schemas';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// CLASSIFY — gpt-4o-mini, fast filter
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM = `Tu es un assistant filtrage pour avocat contentieux commercial français.
Tu vas recevoir un email + résumé pièces jointes. Réponds en JSON strict.
IMPORTANT : "has_actionable_dates" doit être TRUE uniquement si l'email contient une date CRITIQUE : audience, dépôt de conclusions, clôture d'instruction, closing M&A, ou rendez-vous stratégique majeur. Les envois de documents, transmissions de pièces, accusés de réception, et réunions préparatoires internes ne sont PAS des dates critiques → has_actionable_dates:false.`;

export async function classifyMessage(input: {
  subject: string | null;
  body_text: string | null;
  attachments_text: string;
}): Promise<ClassificationResult> {
  const subjectLine = input.subject ? `[subject] ${input.subject}` : '[subject] (sans objet)';
  const bodySnippet = (input.body_text || '').substring(0, 1500);
  const attSnippet = (input.attachments_text || '').substring(0, 1000);

  const userContent = `${subjectLine}
[body, max 1500 chars]
${bodySnippet}
[attachments, max 1000 chars]
${attSnippet}

JSON:
{
  "has_actionable_dates": bool,
  "doc_type": "email_procedural" | "contract" | "meeting_request" | "informational" | "other",
  "rough_count": int
}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    store: false,
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[extractor] classify: JSON.parse failed, raw:', raw.substring(0, 200));
    return { has_actionable_dates: false, doc_type: 'other', rough_count: 0 };
  }

  const result = ClassificationResultSchema.safeParse(parsed);
  if (!result.success) {
    console.warn('[extractor] classify: Zod validation failed:', result.error.message);
    return { has_actionable_dates: false, doc_type: 'other', rough_count: 0 };
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// EXTRACT — gpt-4o, strict JSON schema via zodResponseFormat
// ---------------------------------------------------------------------------

// current_date is injected at runtime so the LLM can filter past dates
const CURRENT_DATE = new Date().toISOString().slice(0, 10);

const EXTRACT_SYSTEM = `Tu es expert en extraction d'événements juridiques critiques pour cabinet d'avocat contentieux commercial français.
Date du jour : ${CURRENT_DATE}.

MISSION : Extraire UNIQUEMENT les dates critiques d'un dossier juridique de contentieux ou d'opération commerciale structurée.
Les dates critiques sont EXCLUSIVEMENT :
- "hearing" : audience, plaidoirie, comparution — date imposée par le tribunal
- "filing_deadline" : date limite de dépôt de conclusions, communication de pièces — délai de rigueur imposé par ordonnance ou calendrier procédural
- "procedural_deadline" : clôture d'instruction, ordonnance de mise en état, injonction procédurale explicite (hors dépôt)
- "commercial_deadline" : closing M&A, date de paiement d'un prix, échéance de prescription irrévocable, renouvellement contractuel ferme
- "meeting" : rendez-vous stratégique majeur avec le client (point stratégie, comité de direction, réunion d'arbitrage) — PAS les calls préparatoires internes
- "unknown" : date détectée mais type ambigu

IGNORER ABSOLUMENT (ne pas créer d'événement pour) :
- Envois de documents, transmission de pièces, accusés de réception
- RDV opérationnels internes (réunions préparatoires, calls de coordination entre avocats)
- Dates de signature interne sans portée externe imposée
- Mentions historiques de dates passées (audiiences déjà tenues, délais expirés)
- Dates de facturation et de paiement d'honoraires du cabinet
- Dates de réunions de comité d'entreprise ou instances sociales accessoires
- Si une date apparaît dans plusieurs emails du même dossier (ex: même audience mentionnée 5 fois), n'extraire QU'UN SEUL événement — le plus précis

FILTRE TEMPOREL STRICT :
- Ne jamais extraire une date antérieure à ${CURRENT_DATE}. Si la date est passée, ignorer complètement.
- Exception : si une date passée est mentionnée comme base de calcul d'un délai futur, calculer la date future et l'extraire.

Règles strictes :
1. Si la date est implicite ("la semaine prochaine") sans date absolue déductible, NE PAS créer d'événement.
2. Pour "court_or_context", "client", "counterparty", "case_ref" : null si non identifiable explicitement.
3. "source_excerpt" : phrase EXACTE (max 300 chars) du texte d'origine qui contient la date.
4. "confidence" : 0..1. >= 0.85 si date+type+contexte clairs et date critique. < 0.6 si date accessoire ou ambiguë.
5. Un seul email peut générer au MAXIMUM 1 événement. Si tu détectes plusieurs dates, ne retenir que la principale et la plus critique.`;

async function callExtract(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<ExtractionResult | null> {
  try {
    const completion = await openai.beta.chat.completions.parse({
      model: 'gpt-4o',
      temperature: 0,
      store: false,
      messages,
      response_format: zodResponseFormat(ExtractionResultSchema, 'extraction_result'),
    });

    const msg = completion.choices[0]?.message;
    if (msg?.parsed) {
      return msg.parsed as ExtractionResult;
    }
    // Fallback: try manual parse of content
    const raw = msg?.content ?? '';
    if (raw) {
      const parsed = JSON.parse(raw);
      const result = ExtractionResultSchema.safeParse(parsed);
      if (result.success) return result.data;
    }
    return null;
  } catch (err: any) {
    console.warn('[extractor] extract: callExtract error:', err.message);
    return null;
  }
}

export async function extractEvents(input: {
  subject: string | null;
  from: string | null;
  date_sent: string | null;
  body_text: string | null;
  attachments_text: string;
}): Promise<ExtractionResult> {
  const subjectLine = input.subject ? `[subject] ${input.subject}` : '[subject] (sans objet)';
  const fromLine = input.from ? `[from] ${input.from}` : '[from] inconnu';
  const dateLine = input.date_sent ? `[date_sent] ${input.date_sent}` : '[date_sent] inconnue';
  const bodySnippet = (input.body_text || '').substring(0, 4000);
  const attSnippet = (input.attachments_text || '').substring(0, 4000);

  const userContent = `${subjectLine}
${fromLine}
${dateLine}
[body]
${bodySnippet}
[attachments]
${attSnippet}`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: userContent },
  ];

  // First attempt
  let result = await callExtract(messages);
  if (result) return result;

  // 1 retry with correction prompt
  console.warn('[extractor] extract: first attempt failed, retrying with correction prompt');
  const retryMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...messages,
    {
      role: 'system',
      content: 'Ton JSON précédent était invalide. Reformate strictement selon le schéma.',
    },
  ];
  result = await callExtract(retryMessages);
  if (result) return result;

  // Skip silently
  console.warn('[extractor] extract: both attempts failed, returning empty events');
  return { events: [] };
}
