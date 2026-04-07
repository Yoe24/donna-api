/**
 * dossier-enricher.ts
 *
 * Enrichit un dossier avec :
 *   - aggregateEcheances    : union des key_dates de tous les emails du dossier
 *   - aggregateResumePj     : concat des resume_ia des dossier_documents
 *   - regenerateDossierSummary : GPT-4o sur les 50 emails récents + resume_pj
 *   - enrichDossier         : orchestrateur avec debounce 5 min
 *
 * Toutes les erreurs sont catchées et loggées — jamais de throw au caller.
 */

import OpenAI from 'openai';
import { supabase } from '../config/supabase';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEBOUNCE_MINUTES = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Echeance {
  date: string;       // YYYY-MM-DD
  label: string;
  source_email_id?: string;
}

// ─── aggregateEcheances ───────────────────────────────────────────────────────

export async function aggregateEcheances(dossierId: string): Promise<void> {
  try {
    // Fetch all emails for this dossier that have classification.key_dates
    const { data: emailRows, error } = await supabase
      .from('emails')
      .select('id, classification')
      .eq('dossier_id', dossierId)
      .not('classification', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(`[dossier-enricher] aggregateEcheances fetch error (dossier ${dossierId}):`, error.message);
      return;
    }

    // Collect all key_dates from classification jsonb
    const allEcheances: Echeance[] = [];
    const seen = new Set<string>();

    for (const row of (emailRows || [])) {
      const keyDates: string[] = row.classification?.key_dates || [];
      for (const entry of keyDates) {
        if (!entry || typeof entry !== 'string') continue;

        // Format: "YYYY-MM-DD — description" or "YYYY-MM-DD - description"
        const match = entry.match(/^(\d{4}-\d{2}-\d{2})\s*[—\-]+\s*(.+)$/);
        if (!match) continue;

        const dateStr = match[1];
        const label = match[2].trim();

        // Dedup by (date+label normalised)
        const key = `${dateStr}|${label.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        allEcheances.push({
          date: dateStr,
          label,
          source_email_id: row.id,
        });
      }
    }

    // Sort chronologically
    allEcheances.sort((a, b) => a.date.localeCompare(b.date));

    const { error: updateErr } = await supabase
      .from('dossiers')
      .update({ echeances: allEcheances })
      .eq('id', dossierId);

    if (updateErr) {
      console.error(`[dossier-enricher] aggregateEcheances update error (dossier ${dossierId}):`, updateErr.message);
    } else {
      console.log(`[dossier-enricher] aggregateEcheances: ${allEcheances.length} échéances agrégées pour dossier ${dossierId}`);
    }
  } catch (e: any) {
    console.error(`[dossier-enricher] aggregateEcheances exception (dossier ${dossierId}):`, e.message);
  }
}

// ─── aggregateResumePj ────────────────────────────────────────────────────────

export async function aggregateResumePj(dossierId: string): Promise<void> {
  try {
    const { data: docs, error } = await supabase
      .from('dossier_documents')
      .select('nom_fichier, resume_ia')
      .eq('dossier_id', dossierId)
      .not('resume_ia', 'is', null)
      .limit(20);

    if (error) {
      console.error(`[dossier-enricher] aggregateResumePj fetch error (dossier ${dossierId}):`, error.message);
      return;
    }

    if (!docs || docs.length === 0) {
      // Nothing to aggregate — leave resume_pj as-is (or set to null)
      return;
    }

    const lines = docs.map((d: any) => `- ${d.nom_fichier}: ${d.resume_ia}`);
    const resumePj = lines.join('\n');

    const { error: updateErr } = await supabase
      .from('dossiers')
      .update({ resume_pj: resumePj })
      .eq('id', dossierId);

    if (updateErr) {
      console.error(`[dossier-enricher] aggregateResumePj update error (dossier ${dossierId}):`, updateErr.message);
    } else {
      console.log(`[dossier-enricher] aggregateResumePj: ${docs.length} PJ agrégées pour dossier ${dossierId}`);
    }
  } catch (e: any) {
    console.error(`[dossier-enricher] aggregateResumePj exception (dossier ${dossierId}):`, e.message);
  }
}

// ─── regenerateDossierSummary ─────────────────────────────────────────────────

export async function regenerateDossierSummary(dossierId: string): Promise<void> {
  try {
    // Fetch dossier metadata
    const { data: dossier, error: dossierErr } = await supabase
      .from('dossiers')
      .select('nom_client, email_client, domaine, opposing_party, case_reference, resume_pj')
      .eq('id', dossierId)
      .single();

    if (dossierErr || !dossier) {
      console.error(`[dossier-enricher] regenerateDossierSummary: dossier non trouvé (${dossierId})`);
      return;
    }

    // Fetch 50 most recent emails (subject + resume + classification summary)
    const { data: emails, error: emailsErr } = await supabase
      .from('emails')
      .select('objet, resume, classification, created_at')
      .eq('dossier_id', dossierId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (emailsErr) {
      console.error(`[dossier-enricher] regenerateDossierSummary: emails fetch error:`, emailsErr.message);
      return;
    }

    const emailLines = (emails || []).map((e: any) => {
      const date = e.created_at ? e.created_at.substring(0, 10) : '?';
      const summary = e.classification?.summary || e.resume || '';
      return `[${date}] ${e.objet || '(sans sujet)'} — ${summary}`;
    });

    const emailsText = emailLines.join('\n');

    const systemPrompt = `Tu es Donna, secrétaire juridique experte. Tu analyses des dossiers d'avocat et génères des résumés factuels et concis.

RÈGLES STRICTES :
- Résumé en 3 à 5 phrases factuelles maximum
- Mentionner : qui est le client, quelle est l'affaire, où en est-on
- Si applicable : mentionner la partie adverse, les références de dossier
- Ton neutre, professionnel, factuel
- Ne pas inventer d'informations non présentes dans les données
- Répondre UNIQUEMENT avec le texte du résumé, sans titre ni markdown`;

    const userContent = `Dossier : ${dossier.nom_client || 'Inconnu'} (${dossier.email_client || ''})
Domaine : ${dossier.domaine || 'Non précisé'}
Partie adverse : ${dossier.opposing_party || 'Non identifiée'}
Référence : ${dossier.case_reference || 'Aucune'}

${emails && emails.length > 0 ? `Échanges récents (${emails.length} derniers) :\n${emailsText}` : 'Aucun échange enregistré.'}

${dossier.resume_pj ? `Pièces jointes :\n${dossier.resume_pj}` : ''}

Génère un résumé factuel de la situation actuelle de ce dossier.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 300,
      store: false,
    });

    const resumeSituation = (completion.choices[0].message.content || '').trim();

    if (!resumeSituation) {
      console.warn(`[dossier-enricher] regenerateDossierSummary: GPT a renvoyé une réponse vide pour ${dossierId}`);
      return;
    }

    const { error: updateErr } = await supabase
      .from('dossiers')
      .update({
        resume_situation: resumeSituation,
        last_summary_update: new Date().toISOString(),
      })
      .eq('id', dossierId);

    if (updateErr) {
      console.error(`[dossier-enricher] regenerateDossierSummary update error (dossier ${dossierId}):`, updateErr.message);
    } else {
      console.log(`[dossier-enricher] regenerateDossierSummary: résumé régénéré pour dossier ${dossierId}`);
    }
  } catch (e: any) {
    console.error(`[dossier-enricher] regenerateDossierSummary exception (dossier ${dossierId}):`, e.message);
  }
}

// ─── enrichDossier (orchestrateur avec debounce) ──────────────────────────────

export async function enrichDossier(dossierId: string): Promise<void> {
  if (!dossierId) {
    console.warn('[dossier-enricher] enrichDossier: dossierId manquant, skip');
    return;
  }

  try {
    // Always run cheap aggregations (no GPT cost)
    await aggregateEcheances(dossierId);
    await aggregateResumePj(dossierId);

    // Check debounce for GPT summary (avoid spamming on email bursts)
    const { data: dossier, error } = await supabase
      .from('dossiers')
      .select('last_summary_update')
      .eq('id', dossierId)
      .single();

    if (error) {
      console.error(`[dossier-enricher] enrichDossier debounce check error (dossier ${dossierId}):`, error.message);
      // Still try to regenerate even if we can't check debounce
      await regenerateDossierSummary(dossierId);
      return;
    }

    const lastUpdate = dossier?.last_summary_update ? new Date(dossier.last_summary_update) : null;
    const minutesSinceLast = lastUpdate
      ? (Date.now() - lastUpdate.getTime()) / 60000
      : Infinity;

    if (minutesSinceLast < DEBOUNCE_MINUTES) {
      console.log(
        `[dossier-enricher] enrichDossier: debounce actif pour ${dossierId} (dernière mise à jour il y a ${minutesSinceLast.toFixed(1)}min < ${DEBOUNCE_MINUTES}min) — skip GPT`
      );
      return;
    }

    await regenerateDossierSummary(dossierId);
  } catch (e: any) {
    console.error(`[dossier-enricher] enrichDossier exception (dossier ${dossierId}):`, e.message);
  }
}
