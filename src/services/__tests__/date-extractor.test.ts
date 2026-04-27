/**
 * src/services/__tests__/date-extractor.test.ts
 *
 * Unit tests for date-extractor.ts.
 * All tests use useLLMFallback=false (no network calls required).
 * Reference date fixed to 2026-04-27 for year-inference tests.
 */

import { extractDatesFromEmail, deduplicateEvents, toParisISO } from '../date-extractor';

// Fixed reference date for deterministic year-inference behaviour
const REF_DATE = new Date('2026-04-27T12:00:00Z');

// ─── toParisISO helper ────────────────────────────────────────────────────────

describe('toParisISO', () => {
  test('returns CET offset (+01:00) for a winter date', () => {
    const iso = toParisISO(2026, 11, 15, 9, 0);
    // November is in CET (+01:00) in Europe/Paris
    expect(iso).toBe('2026-11-15T09:00:00+01:00');
  });

  test('returns CEST offset (+02:00) for a summer date', () => {
    const iso = toParisISO(2026, 7, 1, 9, 0);
    expect(iso).toBe('2026-07-01T09:00:00+02:00');
  });
});

// ─── Pattern 1: DD/MM/YYYY ────────────────────────────────────────────────────

describe('Pattern 1 — DD/MM/YYYY', () => {
  test('extracts explicit date with slash separator', async () => {
    const events = await extractDatesFromEmail({
      emailBody: 'Audience le 15/11/2026 au TJ Paris.',
      emailSubject: 'Convocation',
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dateStart).toMatch(/^2026-11-15/);
    expect(events[0].sourceType).toBe('email');
    expect(events[0].sourceFilename).toBeNull();
    expect(events[0].confidence).toBe(0.9);
  });

  test('extracts date with dot separator and 2-digit year (DD.MM.YY)', async () => {
    const events = await extractDatesFromEmail({
      emailBody: 'Forclusion le 15.11.26.',
      emailSubject: 'Forclusion',
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dateStart).toMatch(/^2026-11-15/);
    expect(events[0].confidence).toBe(0.9);
  });
});

// ─── Pattern 2-4: DD <month_fr> (YYYY?) ──────────────────────────────────────

describe('Pattern 2-4 — French month names', () => {
  test('extracts date with time (le DD mois YYYY à HHhMM)', async () => {
    const events = await extractDatesFromEmail({
      emailBody: 'RDV client le 15 novembre 2026 à 14h30.',
      emailSubject: 'RDV',
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    // November is CET (+01:00)
    expect(events[0].dateStart).toBe('2026-11-15T14:30:00+01:00');
  });

  test('infers current year when month has not yet passed (no explicit year)', async () => {
    // Reference: 2026-04-27 — November has not passed yet → year = 2026
    const events = await extractDatesFromEmail({
      emailBody: 'Clôture des débats le 15 novembre.',
      emailSubject: 'Clôture',
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dateStart).toMatch(/^2026-11-15/);
  });

  test('infers next year when month has already passed (no explicit year)', async () => {
    // Reference: 2026-04-27 — February has already passed → year = 2027
    const events = await extractDatesFromEmail({
      emailBody: 'Audience le 10 février.',
      emailSubject: 'Audience',
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dateStart).toMatch(/^2027-02-10/);
  });
});

// ─── Pattern 5: ISO YYYY-MM-DD ────────────────────────────────────────────────

describe('Pattern 5 — ISO date', () => {
  test('extracts ISO format date', async () => {
    const events = await extractDatesFromEmail({
      emailBody: 'La clôture est fixée au 2026-11-15.',
      emailSubject: 'Clôture',
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dateStart).toMatch(/^2026-11-15/);
  });
});

// ─── Natural-language dates with LLM disabled ─────────────────────────────────

describe('Natural-language dates (useLLMFallback=false)', () => {
  test('"demain à 10h" yields no regex events when LLM is disabled', async () => {
    // "demain" is not resolvable by regex — no explicit date present.
    // With useLLMFallback=false the result must be empty.
    const events = await extractDatesFromEmail({
      emailBody: 'Audience demain à 10h au palais de justice.',
      emailSubject: 'Audience',
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    // Regex cannot resolve relative natural-language dates — 0 events expected.
    expect(events).toHaveLength(0);
  });
});

// ─── Attachment source ────────────────────────────────────────────────────────

describe('Attachment extraction', () => {
  test('extracts date from attachment with correct sourceType and filename', async () => {
    const events = await extractDatesFromEmail({
      emailBody: 'Veuillez trouver ci-joint la convocation.',
      emailSubject: 'Convocation',
      attachments: [
        { filename: 'convocation.pdf', text: 'Audience le 03/12/2026 à 09h30 au TGI.' },
      ],
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    expect(events[0].sourceType).toBe('attachment');
    expect(events[0].sourceFilename).toBe('convocation.pdf');
    expect(events[0].dateStart).toMatch(/^2026-12-03/);
    // December is CET (+01:00); time 09h30 extracted from attachment text
    expect(events[0].dateStart).toMatch(/T09:30:00\+01:00$/);
  });
});

// ─── Deduplication ────────────────────────────────────────────────────────────

describe('Deduplication', () => {
  test('same date + same context in body and attachment → deduplicated to 1 event', async () => {
    // Identical text in body and attachment → identical titles → deduplication fires.
    // Both sources have confidence=0.9 so the first one (email) is kept.
    const SHARED_TEXT = 'Audience le 03/12/2026 au TJ Paris.';
    const events = await extractDatesFromEmail({
      emailBody: SHARED_TEXT,
      emailSubject: 'Audience',
      attachments: [{ filename: 'convocation.pdf', text: SHARED_TEXT }],
      useLLMFallback: false,
      _referenceDate: REF_DATE,
    });

    expect(events).toHaveLength(1);
    expect(events[0].dateStart).toMatch(/^2026-12-03/);
    expect(events[0].confidence).toBe(0.9);
  });

  test('deduplicateEvents keeps higher-confidence event when titles overlap', () => {
    // llmEvent title ("Audience") is a substring of regexEvent title ("Audience TJ Paris")
    // → treated as duplicate → higher confidence (0.9) survives.
    const regexEvent = {
      dateStart: '2026-11-15T09:00:00+01:00',
      dateEnd: null,
      title: 'Audience TJ Paris',
      description: null,
      sourceType: 'email' as const,
      sourceFilename: null,
      confidence: 0.9,
    };
    const llmEvent = {
      dateStart: '2026-11-15T09:00:00+01:00',
      dateEnd: null,
      title: 'Audience',
      description: null,
      sourceType: 'email' as const,
      sourceFilename: null,
      confidence: 0.6,
    };

    const result = deduplicateEvents([llmEvent, regexEvent]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
    expect(result[0].title).toBe('Audience TJ Paris');
  });
});
