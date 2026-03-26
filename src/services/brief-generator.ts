import OpenAI from 'openai';
import { supabase } from '../config/supabase';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Dossier {
  id: string;
  nom_client: string;
  email_client: string | null;
  domaine: string | null;
  resume_situation: string | null;
  statut: string;
}

interface Email {
  id: string;
  expediteur: string | null;
  objet: string | null;
  resume: string | null;
  created_at: string | null;
  needs_response: boolean | null;
  classification: string | null;
}

interface DossierParsedResponse {
  summary?: string;
  dates_cles?: string[];
  emails_recus?: string[];
  needs_immediate_attention?: boolean;
}

interface DossierSummary {
  dossier_id: string;
  nom: string;
  new_emails_count: number;
  summary: string;
  dates_cles: string[];
  emails_recus: string[];
  needs_immediate_attention: boolean;
}

interface BriefStats {
  emails_analyzed: number;
  dossiers_count: number;
  needs_response_count: number;
  deadline_soon_count?: number;
}

interface BriefContent {
  executive_summary: string;
  is_first_brief?: boolean;
  stats: BriefStats;
  dossiers: DossierSummary[];
}

interface SavedBrief {
  id: string;
  user_id: string;
  brief_date: string;
  content: BriefContent;
  is_read: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const DOSSIER_PROMPT =
  "Tu es Donna, secrétaire juridique numérique. Tu fais un compte-rendu factuel pour l'avocate.\n\n" +
  "Pour ce dossier, liste ce qui est arrivé récemment. Renvoie UNIQUEMENT un JSON valide :\n" +
  "{\n" +
  '  "summary": "Compte-rendu factuel en 1-2 phrases de ce qui est arrivé. Pas de conseil, pas d\'analyse. Juste les faits : qui a écrit, quoi, quand.",\n' +
  '  "dates_cles": ["4 avril 2026 — Audience TGI Paris", "31 mars 2026 — Entretien préalable licenciement"],\n' +
  '  "emails_recus": ["Greffe TGI — Convocation audience", "Me Bernard — Conclusions adverses", "M. Dupont — Question sur son dossier"],\n' +
  '  "needs_immediate_attention": true/false\n' +
  "}\n\n" +
  "RÈGLES :\n" +
  "- Tu ne dis JAMAIS 'vous devriez', 'il faudrait', 'nous recommandons'\n" +
  "- Tu ne donnes JAMAIS de conseil juridique ni de stratégie\n" +
  "- Tu résumes ce qui S'EST PASSÉ, pas ce qui devrait se passer\n" +
  "- Tu listes les emails reçus de manière factuelle\n" +
  "- Tu identifies les dates et deadlines trouvées dans les emails\n" +
  "- needs_immediate_attention = true UNIQUEMENT si une deadline tombe dans les 3 prochains jours\n" +
  "- Ton ton est celui d'une secrétaire qui fait un rapport : factuel, précis, court";

function getExecPrompt(periodDays: number): string {
  let periodIntro: string;

  if (periodDays <= 1) {
    periodIntro =
      "Tu fais le compte-rendu de la journée d'hier et de ce matin. Commence par 'Depuis hier, vous avez reçu X emails sur Y dossiers.' puis liste les faits marquants.";
  } else if (periodDays <= 7) {
    periodIntro =
      "Tu fais le compte-rendu de la semaine. Commence par 'Cette semaine, vous avez reçu X emails sur Y dossiers.' puis liste les faits marquants.";
  } else {
    periodIntro =
      "Tu fais le premier bilan après connexion. Commence par 'Donna a analysé vos X derniers emails et identifié Y dossiers.' puis liste les faits marquants.";
  }

  return (
    "Tu es Donna, secrétaire juridique numérique. Tu fais un compte-rendu pour l'avocate.\n\n" +
    periodIntro +
    "\n\n" +
    "RÈGLES :\n" +
    "- Pas de conseil, pas de priorités. Juste un rapport factuel de ce qui est arrivé\n" +
    "- Mentionne les dossiers qui ont eu du mouvement\n" +
    "- Mentionne les dates/deadlines identifiées dans les prochains jours\n" +
    "- Ton INTERDIT : 'Commencez par contacter...', 'Préparez-vous...', 'Il faudrait...' — ça c'est du conseil, Donna ne fait pas ça\n\n" +
    "Réponds en texte brut, pas en JSON."
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateBrief(
  userId: string,
  periodDays: number = 7,
): Promise<SavedBrief> {
  console.log('📋 Brief generation started for user:', userId, '| period:', periodDays, 'days');

  const cutoffDate = new Date(Date.now() - periodDays * 24 * 3600 * 1000).toISOString();

  // 1. Récupérer tous les dossiers actifs du user
  const { data: dossiers, error: dossierErr } = await supabase
    .from('dossiers')
    .select('id, nom_client, email_client, domaine, resume_situation, statut')
    .eq('user_id', userId)
    .eq('statut', 'actif');

  if (dossierErr) {
    console.error('❌ Brief: erreur récupération dossiers:', dossierErr.message);
    throw new Error('Erreur récupération dossiers: ' + dossierErr.message);
  }

  if (!dossiers || dossiers.length === 0) {
    console.log('📋 Brief: aucun dossier actif trouvé');
    const emptyBrief: BriefContent = {
      executive_summary: 'Aucun dossier actif trouvé. Connectez votre boîte mail pour commencer.',
      stats: { emails_analyzed: 0, dossiers_count: 0, needs_response_count: 0 },
      dossiers: [],
    };
    return await saveBrief(userId, emptyBrief);
  }

  // 2. Pour chaque dossier, récupérer les emails récents
  const dossierSummaries: DossierSummary[] = [];
  let totalEmails = 0;
  let needsResponseCount = 0;
  let deadlineSoonCount = 0;

  for (const dossier of dossiers as Dossier[]) {
    const { data: emails, error: emailErr } = await supabase
      .from('emails')
      .select('id, expediteur, objet, resume, created_at, needs_response, classification')
      .eq('dossier_id', dossier.id)
      .eq('user_id', userId)
      .gte('created_at', cutoffDate)
      .neq('pipeline_step', 'ignore')
      .order('created_at', { ascending: false })
      .limit(20);

    if (emailErr) {
      console.error('❌ Brief: erreur emails dossier ' + dossier.nom_client + ':', emailErr.message);
      continue;
    }

    if (!emails || emails.length === 0) continue;

    totalEmails += emails.length;

    (emails as Email[]).forEach((e) => {
      if (e.needs_response === true) needsResponseCount++;
    });

    // 3. Appeler GPT-4o pour compte-rendu factuel du dossier
    const emailsList = (emails as Email[])
      .map((e, i) => {
        const date = e.created_at
          ? new Date(e.created_at).toLocaleDateString('fr-FR')
          : '?';
        return (
          (i + 1) +
          '. De: ' +
          (e.expediteur || '?') +
          ' | Objet: ' +
          (e.objet || '(sans objet)') +
          ' | Date: ' +
          date +
          ' | Résumé: ' +
          (e.resume || '(non analysé)').substring(0, 200)
        );
      })
      .join('\n');

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        store: false,
        messages: [
          { role: 'system', content: DOSSIER_PROMPT },
          {
            role: 'user',
            content:
              'Dossier : ' +
              dossier.nom_client +
              ' — ' +
              (dossier.resume_situation || 'pas de résumé') +
              '\n\nEmails récents :\n' +
              emailsList,
          },
        ],
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      });

      const raw = (completion.choices[0].message.content || '').trim();
      const parsed: DossierParsedResponse = JSON.parse(raw);

      const needsAttention = parsed.needs_immediate_attention || false;
      if (needsAttention) deadlineSoonCount++;

      dossierSummaries.push({
        dossier_id: dossier.id,
        nom: dossier.nom_client,
        new_emails_count: emails.length,
        summary: parsed.summary || '',
        dates_cles: parsed.dates_cles || [],
        emails_recus: parsed.emails_recus || [],
        needs_immediate_attention: needsAttention,
      });

      console.log(
        '📋 Dossier ' + dossier.nom_client + ': ' + emails.length + ' emails | attention: ' + needsAttention,
      );
    } catch (gptErr: unknown) {
      const message = gptErr instanceof Error ? gptErr.message : String(gptErr);
      console.error('❌ Brief GPT error for ' + dossier.nom_client + ':', message);
      dossierSummaries.push({
        dossier_id: dossier.id,
        nom: dossier.nom_client,
        new_emails_count: emails.length,
        summary: emails.length + " email(s) reçu(s) — erreur lors de l'analyse.",
        dates_cles: [],
        emails_recus: [],
        needs_immediate_attention: false,
      });
    }
  }

  // 4. Trier : dossiers avec deadlines proches en premier, puis par nombre d'emails
  dossierSummaries.sort((a, b) => {
    if (a.needs_immediate_attention && !b.needs_immediate_attention) return -1;
    if (!a.needs_immediate_attention && b.needs_immediate_attention) return 1;
    return b.new_emails_count - a.new_emails_count;
  });

  // 5. Générer le résumé exécutif factuel
  let executiveSummary = '';

  if (dossierSummaries.length > 0) {
    const dossiersListForExec = dossierSummaries
      .map((d) => {
        let line = d.nom + ' — ' + d.new_emails_count + ' email(s) — ' + d.summary;
        if (d.dates_cles.length > 0) line += ' — Dates: ' + d.dates_cles.join(', ');
        return line;
      })
      .join('\n');

    try {
      const execCompletion = await openai.chat.completions.create({
        model: 'gpt-4o',
        store: false,
        messages: [
          { role: 'system', content: getExecPrompt(periodDays) },
          {
            role: 'user',
            content:
              'Total emails: ' +
              totalEmails +
              '\nTotal dossiers avec activité: ' +
              dossierSummaries.length +
              '\n\nDossiers :\n' +
              dossiersListForExec,
          },
        ],
        temperature: 0.2,
        max_tokens: 300,
      });
      executiveSummary = (execCompletion.choices[0].message.content || '').trim();
    } catch (execErr: unknown) {
      const message = execErr instanceof Error ? execErr.message : String(execErr);
      console.error('❌ Brief exec summary error:', message);
      executiveSummary =
        'Vous avez reçu ' + totalEmails + ' emails sur ' + dossierSummaries.length + ' dossiers.';
    }
  } else {
    executiveSummary = 'Aucune activité récente détectée sur vos dossiers.';
  }

  // 6. Compiler et sauvegarder
  const briefContent: BriefContent = {
    executive_summary: executiveSummary,
    is_first_brief: periodDays > 7,
    stats: {
      emails_analyzed: totalEmails,
      dossiers_count: dossierSummaries.length,
      needs_response_count: needsResponseCount,
      deadline_soon_count: deadlineSoonCount,
    },
    dossiers: dossierSummaries,
  };

  const savedBrief = await saveBrief(userId, briefContent);
  console.log('📋 Brief généré avec succès:', totalEmails, 'emails,', dossierSummaries.length, 'dossiers');
  return savedBrief;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function saveBrief(userId: string, content: BriefContent): Promise<SavedBrief> {
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('briefs')
    .upsert(
      {
        user_id: userId,
        brief_date: today,
        content,
        is_read: false,
      },
      { onConflict: 'user_id,brief_date' },
    )
    .select()
    .single();

  if (error) {
    console.error('❌ Brief save error:', error.message);
    throw new Error('Erreur sauvegarde brief: ' + error.message);
  }

  console.log('💾 Brief sauvegardé — id:', data.id, '| date:', today);
  return data as SavedBrief;
}
