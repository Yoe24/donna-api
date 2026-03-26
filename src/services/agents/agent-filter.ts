import OpenAI from 'openai';
import { supabase } from '../../config/supabase';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function extractEmailAddress(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return match ? match[1].trim().toLowerCase() : sender.trim().toLowerCase();
}

async function isKnownClient(emailAddress: string, userId: string): Promise<boolean> {
  try {
    const r = await supabase
      .from('dossiers')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .ilike('email_client', emailAddress);
    return r.count !== null && r.count > 0;
  } catch (e: any) {
    console.error('Filter: Supabase check failed:', e.message);
    return false;
  }
}

function isObviouslyProfessional(emailAddress: string, sender: string, subject: string): string | null {
  const addr = emailAddress.toLowerCase();
  const senderLower = (sender || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();

  if (addr.includes('@justice.fr') || addr.includes('@justice.gouv.fr')) return 'juridiction';
  if (addr.includes('greffe') || addr.includes('tribunal') || addr.includes('jaf')) return 'juridiction';
  if (addr.startsWith('maitre.') || addr.startsWith('me.') || addr.startsWith('cabinet')) return 'confrere';
  if (addr.includes('@avocats-') || addr.includes('@barreau-') || addr.includes('@avocat')) return 'confrere';
  if (senderLower.includes('maître') || senderLower.includes('maitre') || senderLower.match(/\bme\b\s/)) return 'confrere';
  if (addr.includes('notaire') || addr.includes('@notaires')) return 'notaire';
  if (addr.includes('huissier') || addr.includes('commissaire-justice')) return 'huissier';
  if (addr.includes('@direccte') || addr.includes('inspection.travail') || addr.includes('@prefecture')) return 'administration';
  if (addr.startsWith('syndic@') || addr.includes('@foncia') || addr.includes('gestion@')) return 'syndic';
  if (senderLower.includes('syndic') || senderLower.includes('foncia')) return 'syndic';
  if (addr.startsWith('compta@') || addr.startsWith('comptabilite@') || addr.startsWith('facturation@')) return 'cabinet_interne';
  if (addr.includes('@cabinet-fernandez') || addr.includes('@cabinet')) return 'cabinet_interne';
  if (subjectLower.match(/\brg\s*\d/) || subjectLower.includes('n° ') || subjectLower.includes('dossier')) return 'reference_dossier';
  if (subjectLower.includes('convocation') || subjectLower.includes('audience') || subjectLower.includes('assignation')) return 'juridiction';
  if (subjectLower.includes('succession') || subjectLower.includes('pension') || subjectLower.includes('garde')) return 'reference_dossier';

  return null;
}

const FILTER_SYSTEM_PROMPT = `Tu es le filtre de tri de Donna, assistante IA d'une avocate française spécialisée en droit civil et droit de la famille.

Ta mission : déterminer si un email est PERTINENT (doit être traité) ou NON PERTINENT (peut être ignoré).

=== PERTINENT (pertinent: true) — TOUJOURS traiter ===
- Emails de clients (personnes physiques qui écrivent à l'avocate)
- Emails de confrères avocats (Maître, Me, @avocats-xxx.fr, @barreau-xxx.fr, cabinet-)
- Emails du greffe et des juridictions (@justice.fr, @justice.gouv.fr, tribunal, greffe, JAF, TGI)
- Emails de notaires (@notaires.fr, notaire)
- Emails d'huissiers et commissaires de justice
- Emails d'administrations liées aux dossiers (inspection du travail, DIRECCTE, préfecture)
- Emails de syndics et gestionnaires immobiliers (syndic@, Foncia, gestion copropriété)
- Emails contenant des références de dossier (RG, numéro d'affaire, convocation, audience)
- Emails de la comptabilité ou gestion interne du cabinet
- Emails d'assurance professionnelle (RC Pro, renouvellement)
- Emails de l'Ordre des Avocats (formation, obligation professionnelle)
- TOUT email qui pourrait concerner un dossier en cours ou l'activité du cabinet

=== NON PERTINENT (pertinent: false) — Ignorer ===
- Newsletters marketing (sauf juridiques professionnelles)
- Spam et phishing
- Publicités commerciales (promotions, soldes, offres)
- Réseaux sociaux (notifications LinkedIn, Facebook, etc.)
- Emails automatiques non professionnels

=== RÈGLE D'OR ===
DANS LE DOUTE, MARQUE COMME PERTINENT.

Réponds UNIQUEMENT en JSON valide sans markdown :
{ "categorie": "client|confrere|juridiction|notaire|administration|cabinet|prospect|spam", "pertinent": true/false, "domaine_type": "professionnel|personnel|inconnu", "commentaire": "une phrase max expliquant pourquoi" }`;

interface FilterInput {
  subject: string;
  sender: string;
  bodyPreview: string;
  userId: string;
}

interface FilterResult {
  categorie: string;
  pertinent: boolean;
  domaine_type: string;
  commentaire: string;
}

export async function filterEmail({ subject, sender, bodyPreview, userId }: FilterInput): Promise<FilterResult> {
  const fallback: FilterResult = { categorie: 'prospect', pertinent: true, domaine_type: 'professionnel', commentaire: 'Doute — traité par défaut' };
  try {
    const emailAddress = extractEmailAddress(sender);

    const knownClient = await isKnownClient(emailAddress, userId);
    if (knownClient) {
      return { categorie: 'client', pertinent: true, domaine_type: 'professionnel', commentaire: 'Expéditeur déjà connu dans la base.' };
    }

    const proType = isObviouslyProfessional(emailAddress, sender, subject);
    if (proType) {
      return { categorie: proType, pertinent: true, domaine_type: 'professionnel', commentaire: 'Expéditeur professionnel détecté automatiquement (' + proType + ').' };
    }

    const userContent = 'Expéditeur : ' + sender + '\nSujet : ' + subject + '\nDébut du message : ' + (bodyPreview || '').substring(0, 300);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: FILTER_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      store: false,
    });

    const raw = (completion.choices[0].message.content || '').trim();
    const parsed = JSON.parse(raw);

    return {
      categorie: parsed.categorie || 'prospect',
      pertinent: typeof parsed.pertinent === 'boolean' ? parsed.pertinent : true,
      domaine_type: parsed.domaine_type || 'inconnu',
      commentaire: parsed.commentaire || ''
    };
  } catch (e: any) {
    console.error('Filter error:', e.message);
    return fallback;
  }
}
