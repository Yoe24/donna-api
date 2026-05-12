/**
 * case-matcher.ts
 *
 * Match an email subject against the user's existing dossiers, dynamically.
 *
 * Replaces the previous hard-coded CANONICAL_CASE_NAMES whitelist that lived in
 * agent-importer.ts and ai-processor.ts. Now the "known case keywords" are
 * derived from the user's actual dossiers in the DB at query time.
 *
 * Matching strategy:
 *   - tokens = case_reference (column + metadata) + nom_client (full + ≥4-char parts)
 *   - generic suffixes (SAS, SARL, SA, EURL, SCI, INC, LTD…) are excluded as tokens
 *   - regex word-boundary match, longest token wins (handles partial ambiguity)
 *
 * Bootstrapping: the very first email of a brand-new case does not match
 * anything → caller falls back to sender-based dossier creation (legacy path).
 * From the 2nd email onwards, the newly created nom_client provides tokens.
 */

import { supabase } from '../config/supabase';

export interface DossierToken {
  token: string; // uppercase, ≥ 4 chars
  dossierId: string;
  source: 'nom_client' | 'case_reference';
}

export interface MatchResult {
  dossierId: string;
  token: string;
  source: 'nom_client' | 'case_reference';
}

const GENERIC_SUFFIXES = new Set([
  'SAS', 'SARL', 'SA', 'EURL', 'SCI', 'SCP', 'SELARL', 'SCM', 'ASSO', 'ASSOC',
  'ASSOCIATION', 'GROUPE', 'GROUP', 'COMPANY', 'INC', 'LTD', 'LLC', 'GMBH',
  'AG', 'NV', 'BV', 'SPA', 'SRL', 'PLC',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the token list from a list of dossier rows.
 *
 * Each dossier contributes:
 *   - its case_reference column (if set)
 *   - its metadata.case_reference (if set)
 *   - its nom_client (full uppercase form)
 *   - each "word" of its nom_client (≥ 4 chars, not in GENERIC_SUFFIXES)
 *
 * Duplicates are kept — they all map to the same dossier_id so matching is fine.
 * Callers that need uniqueness should de-dup themselves.
 */
export function buildDossierTokens(
  dossiers: Array<{
    id: string;
    nom_client: string | null;
    case_reference?: string | null;
    metadata?: { case_reference?: string } | null;
  }>,
): DossierToken[] {
  const tokens: DossierToken[] = [];

  for (const d of dossiers) {
    // case_reference column (e.g. "RG 2026/0847")
    if (d.case_reference) {
      tokens.push({ token: d.case_reference.toUpperCase(), dossierId: d.id, source: 'case_reference' });
    }
    // metadata.case_reference (legacy CASEREF storage)
    const metaRef = d.metadata?.case_reference;
    if (metaRef) {
      tokens.push({ token: String(metaRef).toUpperCase(), dossierId: d.id, source: 'case_reference' });
    }
    // nom_client — full + word-level tokens
    if (d.nom_client) {
      const upper = d.nom_client.toUpperCase().trim();
      if (upper.length >= 3) {
        tokens.push({ token: upper, dossierId: d.id, source: 'nom_client' });
      }
      const parts = upper.split(/[\s\-_'.,/]+/).filter(p => p.length >= 4 && !GENERIC_SUFFIXES.has(p));
      for (const part of parts) {
        tokens.push({ token: part, dossierId: d.id, source: 'nom_client' });
      }
    }
  }

  return tokens;
}

/**
 * Load active dossiers for a user and build their tokens.
 * Convenience wrapper around buildDossierTokens + supabase query.
 */
export async function loadDossierTokens(userId: string): Promise<DossierToken[]> {
  const { data: dossiers, error } = await supabase
    .from('dossiers')
    .select('id, nom_client, case_reference, metadata')
    .eq('user_id', userId)
    .eq('statut', 'actif');

  if (error) {
    console.error('[case-matcher] loadDossierTokens error:', error.message);
    return [];
  }
  return buildDossierTokens(dossiers || []);
}

/**
 * Try to match a subject against a list of tokens.
 *
 * Returns the first match found, with longest tokens checked first. If two
 * tokens have the same length, the order is the one passed in.
 */
export function matchSubjectAgainstTokens(
  subject: string,
  tokens: DossierToken[],
): MatchResult | null {
  if (!subject || tokens.length === 0) return null;

  const upper = subject.toUpperCase();
  const sorted = [...tokens].sort((a, b) => b.token.length - a.token.length);

  for (const t of sorted) {
    const re = new RegExp(`(^|[^A-Z0-9])${escapeRegex(t.token)}([^A-Z0-9]|$)`);
    if (re.test(upper)) {
      return { dossierId: t.dossierId, token: t.token, source: t.source };
    }
  }
  return null;
}
