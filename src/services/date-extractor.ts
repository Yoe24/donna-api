/**
 * src/services/date-extractor.ts
 *
 * Extracts calendar-relevant date events from email bodies and attachments.
 * Strategy:
 *   1. RegEx pass (5 FR/ISO patterns) — deterministic, confidence=0.9
 *   2. LLM fallback (gpt-4o-mini) for natural-language dates not caught by regex
 *
 * All errors are caught internally. Never throws to the caller.
 */

import { openai } from '../lib/openai';

// ─── Public types ─────────────────────────────────────────────────────────────

export type ExtractedDateEvent = {
  dateStart: string;            // ISO 8601 with Europe/Paris offset
  dateEnd: string | null;
  title: string;                // short contextual label
  description: string | null;   // surrounding context, max ~200 chars
  sourceType: 'email' | 'attachment';
  sourceFilename: string | null;
  confidence: number;           // 0..1
};

// ─── Constants ────────────────────────────────────────────────────────────────

const FR_MONTH_MAP: Record<string, number> = {
  janvier: 1,
  février: 2, fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8, aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12, decembre: 12,
};

const DATE_KEYWORDS = [
  'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
  'semaine', 'mois', 'prochain', 'dernière', 'derniere', 'demain',
  "aujourd'hui", 'hier',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a Europe/Paris ISO 8601 string for the given date/time components.
 * Uses Intl to determine DST-aware offset.
 */
export function toParisISO(
  year: number,
  month: number,
  day: number,
  hour: number = 9,
  minute: number = 0,
): string {
  // Probe noon UTC on that date to determine the Paris offset (avoids DST edge cases)
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  let offsetMinutes = 60; // default CET +1

  try {
    const formatter = new Intl.DateTimeFormat('en', {
      timeZone: 'Europe/Paris',
      timeZoneName: 'shortOffset',
    } as Intl.DateTimeFormatOptions);
    const parts = formatter.formatToParts(probe);
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = tzPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (m) {
      const sign = m[1] === '+' ? 1 : -1;
      const hh = parseInt(m[2], 10);
      const mm = parseInt(m[3] ?? '0', 10);
      offsetMinutes = sign * (hh * 60 + mm);
    }
  } catch {
    // Node < 13 or ICU not available — fall back to CET +1
  }

  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absH = Math.floor(Math.abs(offsetMinutes) / 60);
  const absM = Math.abs(offsetMinutes) % 60;
  const offsetStr = `${sign}${String(absH).padStart(2, '0')}:${String(absM).padStart(2, '0')}`;

  return (
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` +
    `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offsetStr}`
  );
}

/**
 * Expands a 2-digit year to 4 digits (< 50 → 2000s, ≥ 50 → 1900s).
 */
function expandYear(yy: number): number {
  return yy < 50 ? 2000 + yy : 1900 + yy;
}

/**
 * Infers the year for a month-only date (no explicit year).
 * If the month is already past this year, uses next year.
 */
function inferYear(month: number, referenceDate: Date): number {
  const refYear = referenceDate.getFullYear();
  const refMonth = referenceDate.getMonth() + 1; // 1-based
  return month < refMonth ? refYear + 1 : refYear;
}

/**
 * Scans ±20 chars around a regex match for a time expression (HH:MM or HHhMM).
 */
function extractTimeNear(
  text: string,
  matchIndex: number,
  matchLength: number,
): { hour: number; minute: number } | null {
  const start = Math.max(0, matchIndex - 20);
  const end = Math.min(text.length, matchIndex + matchLength + 20);
  const ctx = text.substring(start, end);
  const timeMatch = ctx.match(/\b([01]?\d|2[0-3])[h:]([0-5]\d)?\b/i);
  if (!timeMatch) return null;
  const hour = parseInt(timeMatch[1], 10);
  const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Builds a short title from the ±60 chars surrounding a match.
 * Clips at sentence/clause boundaries.
 */
function buildTitle(
  text: string,
  matchIndex: number,
  matchLength: number,
  fallback: string,
): string {
  const ctxStart = Math.max(0, matchIndex - 60);
  const ctxEnd = Math.min(text.length, matchIndex + matchLength + 60);
  const raw = text.substring(ctxStart, ctxEnd);
  const relPos = matchIndex - ctxStart;

  const before = raw.substring(0, relPos);
  const after = raw.substring(relPos + matchLength);

  // Keep last sentence fragment before the date
  const beforeClean = before.split(/[.!?\n]+/).pop()?.trim() ?? '';
  // Keep first sentence fragment after the date
  const afterClean = after.split(/[.!?\n]+/)[0]?.trim() ?? '';

  const fragment = `${beforeClean} ${afterClean}`.trim();
  return (fragment.substring(0, 100) || fallback).trim();
}

/**
 * Builds a description (wider context, max 200 chars).
 */
function buildDescription(
  text: string,
  matchIndex: number,
  matchLength: number,
): string {
  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(text.length, matchIndex + matchLength + 80);
  return text.substring(start, end).trim().substring(0, 200);
}

// ─── Core regex pass ──────────────────────────────────────────────────────────

interface RawMatch {
  index: number;
  length: number;
  year: number;
  month: number;
  day: number;
  hasExplicitYear: boolean;
}

function runRegexPass(text: string, referenceDate: Date): Array<RawMatch & { source: string }> {
  const results: Array<RawMatch & { source: string }> = [];

  // ── Pattern 1: DD/MM/YYYY or DD/MM/YY (separators: / . -)
  // Spec: /\b(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2}|\d{4})\b/g
  {
    const re = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const rawYear = parseInt(m[3], 10);
      const year = m[3].length === 2 ? expandYear(rawYear) : rawYear;
      if (day < 1 || day > 31 || month < 1 || month > 12) continue;
      results.push({ index: m.index, length: m[0].length, year, month, day, hasExplicitYear: true, source: 'pattern1' });
    }
  }

  // ── Pattern 2/3/4: (le )? DD <month_fr> (YYYY)?
  // Covers: "le 15 novembre 2026", "15 novembre 2026", "15 novembre"
  {
    const monthNames = Object.keys(FR_MONTH_MAP).join('|');
    const re = new RegExp(
      `\\b(?:le\\s+)?(\\d{1,2})\\s+(${monthNames})(?:\\s+(\\d{4}))?\\b`,
      'gi',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const day = parseInt(m[1], 10);
      const monthKey = m[2].toLowerCase();
      const month = FR_MONTH_MAP[monthKey];
      if (!month || day < 1 || day > 31) continue;
      const hasExplicitYear = !!m[3];
      const year = hasExplicitYear ? parseInt(m[3], 10) : inferYear(month, referenceDate);
      results.push({ index: m.index, length: m[0].length, year, month, day, hasExplicitYear, source: 'pattern2-4' });
    }
  }

  // ── Pattern 5: ISO YYYY-MM-DD
  // Spec: /\b(\d{4})-(\d{2})-(\d{2})\b/g
  {
    const re = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      results.push({ index: m.index, length: m[0].length, year, month, day, hasExplicitYear: true, source: 'pattern5' });
    }
  }

  return results;
}

// ─── Convert raw matches → ExtractedDateEvent ─────────────────────────────────

function rawMatchesToEvents(
  matches: Array<RawMatch & { source: string }>,
  text: string,
  subject: string,
  sourceType: 'email' | 'attachment',
  sourceFilename: string | null,
): ExtractedDateEvent[] {
  return matches.map((m) => {
    const time = extractTimeNear(text, m.index, m.length);
    const hour = time?.hour ?? 9;
    const minute = time?.minute ?? 0;
    const dateStart = toParisISO(m.year, m.month, m.day, hour, minute);
    const title = buildTitle(text, m.index, m.length, subject);
    const description = buildDescription(text, m.index, m.length);

    return {
      dateStart,
      dateEnd: null,
      title,
      description,
      sourceType,
      sourceFilename,
      confidence: 0.9,
    };
  });
}

// ─── LLM fallback ─────────────────────────────────────────────────────────────

function hasDateKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return DATE_KEYWORDS.some((kw) => lower.includes(kw));
}

function hasUncoveredKeywords(text: string, matchRanges: Array<[number, number]>): boolean {
  const lower = text.toLowerCase();
  for (const kw of DATE_KEYWORDS) {
    let pos = lower.indexOf(kw);
    while (pos !== -1) {
      const covered = matchRanges.some(([start, end]) => pos >= start - 20 && pos <= end + 20);
      if (!covered) return true;
      pos = lower.indexOf(kw, pos + kw.length);
    }
  }
  return false;
}

async function llmExtractDates(
  emailBody: string,
  emailSubject: string,
  dossierContext: string | undefined,
  referenceDate: Date,
): Promise<ExtractedDateEvent[]> {
  const todayISO = referenceDate.toISOString().substring(0, 10);

  const systemPrompt =
    `Tu es un extracteur de dates juridiques. ` +
    `Aujourd'hui : ${todayISO}. Fuseau horaire : Europe/Paris. ` +
    `Réponds UNIQUEMENT avec un tableau JSON valide (pas de markdown). ` +
    `Format : [{\"date\":\"YYYY-MM-DDTHH:mm:ss+HH:MM\",\"title\":\"...\",\"description\":\"...\"}]. ` +
    `Extrais UNIQUEMENT les dates exprimées en langage naturel (demain, la semaine prochaine, lundi prochain, etc.). ` +
    `Ne pas ré-extraire les dates explicites déjà au format DD/MM/YYYY, DD mois YYYY ou YYYY-MM-DD. ` +
    `Si aucune date naturelle trouvée, renvoie [].`;

  const userContent =
    `Objet : ${emailSubject}\n` +
    (dossierContext ? `Contexte dossier : ${dossierContext}\n` : '') +
    `Corps :\n${emailBody.substring(0, 3000)}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    max_tokens: 600,
    store: false,
  });

  const raw = (completion.choices[0].message.content ?? '').trim();
  // Strip markdown fences if present
  const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed: Array<{ date?: string; title?: string; description?: string }> = JSON.parse(jsonStr);

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item) => item.date && typeof item.date === 'string')
    .map((item) => ({
      dateStart: item.date as string,
      dateEnd: null,
      title: (item.title ?? emailSubject ?? '').substring(0, 100),
      description: (item.description ?? null) as string | null,
      sourceType: 'email' as const,
      sourceFilename: null,
      confidence: 0.6,
    }));
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Deduplicates events that fall on the same calendar day with similar titles.
 * "Similar" = one title is a substring of the other (case-insensitive).
 * Keeps the higher-confidence event.
 */
export function deduplicateEvents(events: ExtractedDateEvent[]): ExtractedDateEvent[] {
  const result: ExtractedDateEvent[] = [];

  for (const candidate of events) {
    const candidateDay = candidate.dateStart.substring(0, 10);
    const candidateTitleLower = candidate.title.toLowerCase();

    const duplicateIdx = result.findIndex((existing) => {
      const existingDay = existing.dateStart.substring(0, 10);
      if (existingDay !== candidateDay) return false;
      const existingTitleLower = existing.title.toLowerCase();
      return (
        candidateTitleLower.includes(existingTitleLower) ||
        existingTitleLower.includes(candidateTitleLower)
      );
    });

    if (duplicateIdx === -1) {
      result.push(candidate);
    } else {
      // Keep higher confidence
      if (candidate.confidence > result[duplicateIdx].confidence) {
        result[duplicateIdx] = candidate;
      }
    }
  }

  return result;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function extractDatesFromEmail(input: {
  emailBody: string;
  emailSubject: string;
  attachments?: Array<{ filename: string; text: string }>;
  dossierContext?: string;
  useLLMFallback?: boolean;
  /** Override reference date (useful for deterministic tests). Defaults to now(). */
  _referenceDate?: Date;
}): Promise<ExtractedDateEvent[]> {
  const {
    emailBody,
    emailSubject,
    attachments = [],
    dossierContext,
    useLLMFallback = true,
    _referenceDate,
  } = input;

  const referenceDate = _referenceDate ?? new Date();
  const allEvents: ExtractedDateEvent[] = [];

  // ── 1. Regex pass on email body
  const bodyMatches = runRegexPass(emailBody, referenceDate);
  allEvents.push(...rawMatchesToEvents(bodyMatches, emailBody, emailSubject, 'email', null));

  // ── 2. Regex pass on each attachment
  for (const att of attachments) {
    const attMatches = runRegexPass(att.text, referenceDate);
    allEvents.push(
      ...rawMatchesToEvents(attMatches, att.text, emailSubject, 'attachment', att.filename),
    );
  }

  // ── 3. LLM fallback for natural-language dates in the body
  if (useLLMFallback && hasDateKeywords(emailBody)) {
    const bodyMatchRanges: Array<[number, number]> = bodyMatches.map((m) => [
      m.index,
      m.index + m.length,
    ]);

    if (hasUncoveredKeywords(emailBody, bodyMatchRanges)) {
      try {
        const llmEvents = await llmExtractDates(emailBody, emailSubject, dossierContext, referenceDate);
        allEvents.push(...llmEvents);
      } catch (err: any) {
        console.warn('[date-extractor] LLM fallback failed (non-blocking):', err?.message ?? err);
      }
    }
  }

  // ── 4. Deduplicate
  return deduplicateEvents(allEvents);
}
