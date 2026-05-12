/**
 * email-status.ts
 *
 * Single source of truth for the two state columns on the `emails` table.
 *
 * The DB has historically maintained two state columns and they drifted apart.
 * This module defines the canonical values and the mapping between them.
 *
 * Long-term (Phase 3 in PIPELINE_AUDIT.md): merge into a single column.
 * Until then: writers MUST use these constants and statutFromPipelineStep()
 * to keep the two columns coherent.
 *
 * ─── pipeline_step ─────────────────────────────────────────────────────────
 * Lifecycle of an email through Donna's AI pipeline. Owned by the backend.
 *
 *   en_attente            → just inserted, AI not started yet
 *   imported              → bulk-imported by agent-importer (initial backlog)
 *   filtrage_en_cours     → agent-filter is classifying
 *   archivage_en_cours    → archiveEmail is matching to a dossier
 *   recherche_contexte    → agent-context is loading dossier history
 *   redaction_brouillon   → agent-drafter is generating summary+reco
 *   pret_a_reviser        → AI done, waiting for lawyer review
 *   ignore                → AI marked it as non-pertinent (filter said spam)
 *
 * ─── statut ────────────────────────────────────────────────────────────────
 * Lifecycle of an email from the lawyer's POV. Mostly owned by the frontend
 * (user actions), but the backend keeps it in sync as long as the user
 * hasn't acted (en_attente).
 *
 *   en_attente            → lawyer hasn't reviewed yet (default for all
 *                           pipeline states except ignore)
 *   traite                → lawyer validated the AI suggestion / replied
 *   ignore                → lawyer dismissed (or AI filter said spam)
 *
 * ─── Coherence rule ────────────────────────────────────────────────────────
 *   pipeline_step === 'ignore'  ⇒  statut === 'ignore'
 *   pipeline_step  !== 'ignore'  ⇒  statut ∈ { 'en_attente', 'traite' }
 *
 * The mapping function statutFromPipelineStep() gives the default statut to
 * write whenever pipeline_step changes. The frontend may upgrade en_attente
 * → traite independently when the user acts.
 */

export const PIPELINE_STEPS = [
  'en_attente',
  'imported',
  'filtrage_en_cours',
  'archivage_en_cours',
  'recherche_contexte',
  'redaction_brouillon',
  'pret_a_reviser',
  'ignore',
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STATUTS = ['en_attente', 'traite', 'ignore'] as const;
export type Statut = (typeof STATUTS)[number];

/**
 * Default statut to write when pipeline_step transitions.
 *
 * Use this in any update of pipeline_step :
 *   await supabase.from('emails').update({
 *     pipeline_step: 'pret_a_reviser',
 *     statut: statutFromPipelineStep('pret_a_reviser'),
 *   }).eq('id', emailId);
 */
export function statutFromPipelineStep(step: PipelineStep): Statut {
  return step === 'ignore' ? 'ignore' : 'en_attente';
}

/**
 * True if the email has reached a "terminal" pipeline state (no more AI work).
 * Useful for queries like "show me everything ready for review".
 */
export function isPipelineTerminal(step: PipelineStep | string | null): boolean {
  return step === 'pret_a_reviser' || step === 'ignore';
}

// ─── direction ────────────────────────────────────────────────────────────
//
// Provenance d'un email vu depuis l'avocat :
//   'received' = mail entrant (inbox) — peut nécessiter une réponse
//   'sent'     = mail sortant (envoyé par l'avocat) — alimente le contexte
//                bidirectionnel, le style detector et le calendrier
//
// Ajouté en BDD via migrations/2026-05-12-email-direction.sql (NOT NULL,
// default 'received', index partiel sur direction='sent').
//
// Le frontend (Phase 1 brouillon-mail) utilise ce flag pour :
//   - afficher le bouton "Brouillon" uniquement sur direction='received'
//   - badge direction sur la fiche email
//   - filtrer les fils bidirectionnels d'un dossier

export const EMAIL_DIRECTIONS = ['received', 'sent'] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];
