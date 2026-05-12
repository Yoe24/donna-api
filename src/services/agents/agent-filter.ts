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

  // Sender domain heuristics — juridictions et professions
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
  if (addr.includes('@cabinet-') || addr.includes('@etude-') || addr.includes('@conseil-')) return 'cabinet_interne';

  // Subject — référence de dossier (RG, numéro affaire)
  if (subjectLower.match(/\brg\s*\d/) || subjectLower.match(/\b\d{4}[\/\-]\d{2,5}\b/)) return 'reference_dossier';
  if (subjectLower.includes('n° ') || subjectLower.includes('dossier')) return 'reference_dossier';

  // Subject — actes judiciaires explicites
  if (subjectLower.match(/\b(convocation|audience|assignation|plaidoirie|requ[êe]te|ordonnance|jugement|mise en demeure|m[eé]diation|expertise|conclusions)\b/)) return 'juridiction';

  // Subject — droit affaires / M&A / contentieux commercial (vocabulaire métier)
  if (subjectLower.match(/\b(signature|closing|loi|term ?sheet|transaction|due ?diligence|s[ée]questre|cession|acquisition|protocole|holding|pacte d['']actionnaires|sas\b|sarl\b|sa\b)\b/)) return 'reference_dossier';

  // Subject — droit famille / civil
  if (subjectLower.match(/\b(succession|pension|garde|divorce|bail|copropri[ée]t[ée]|h[ée]ritier)\b/)) return 'reference_dossier';

  return null;
}

// Last-resort safeguard : un email avec marqueurs juridiques évidents ne devrait jamais
// être classé non-pertinent. Override le LLM si cohérence violée.
function hasJuridicalMarkers(subject: string, bodyPreview: string): boolean {
  const text = ((subject || '') + ' ' + (bodyPreview || '')).toLowerCase();

  // Date FR explicite (lundi 18 mai, 12/05/2026, etc.)
  const hasFrenchDate = /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d{1,2}\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)/i.test(text)
    || /\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(text);

  // Montant € (au moins 4 chiffres = ≥ 1000 €, pour éviter les prix de promo style 9,99 €)
  const hasMoneyAmount = /\b\d{1,3}([ . ]\d{3}){1,}\s*€|\b\d{4,}\s*€|\b\d+(?:[.,]\d+)?\s*(?:k|m|millions?)\s*€/i.test(text);

  // Référence RG / numéro affaire
  const hasCaseRef = /\b(rg\s*\d|n°\s*\d|\d{4}[\/\-]\d{2,5})/i.test(text);

  return hasFrenchDate || hasMoneyAmount || hasCaseRef;
}

const FILTER_SYSTEM_PROMPT = `Tu es le filtre de tri de Donna, assistante IA d'une avocate française (tous domaines : droit civil, famille, affaires, M&A, contentieux commercial, immobilier).

Ta mission : déterminer si un email est PERTINENT (doit être traité) ou NON PERTINENT (peut être ignoré).

=== PERTINENT (pertinent: true) — TOUJOURS traiter ===
- Emails de clients (personnes physiques ou dirigeants d'entreprise qui écrivent à l'avocate)
- Emails de confrères avocats (Maître, Me, @avocats-xxx.fr, @barreau-xxx.fr, cabinet-)
- Emails du greffe et des juridictions (@justice.fr, @justice.gouv.fr, tribunal, greffe, JAF, TGI, TC)
- Emails de notaires (@notaires.fr, notaire)
- Emails d'huissiers et commissaires de justice
- Emails d'administrations liées aux dossiers (inspection du travail, DIRECCTE, préfecture, URSSAF, INPI)
- Emails de syndics et gestionnaires immobiliers (syndic@, Foncia, gestion copropriété)
- Emails de partenaires d'opération (notaires, experts-comptables, banques, fonds d'investissement)
- Emails contenant des références de dossier (RG, numéro d'affaire, convocation, audience)
- Emails liés à des opérations juridiques : signature, closing, LOI (Lettre d'Intention), term sheet, due diligence, séquestre, cession, acquisition, transaction (proposition transactionnelle), conclusions, plaidoirie, médiation, expertise, mise en demeure, requête, ordonnance, jugement
- Emails de la comptabilité ou gestion interne du cabinet
- Emails d'assurance professionnelle (RC Pro, renouvellement)
- Emails de l'Ordre des Avocats (formation, obligation professionnelle)
- TOUT email qui pourrait concerner un dossier en cours ou l'activité du cabinet

=== NON PERTINENT (pertinent: false) — Ignorer ===
- Newsletters marketing grand public (sauf juridiques professionnelles)
- Spam et phishing
- Publicités commerciales de retail (promotions, soldes, codes promo)
- Réseaux sociaux (notifications LinkedIn, Facebook, etc.)
- Emails automatiques non professionnels (confirmations achat e-commerce, livraison, etc.)

=== ATTENTION — FAUX AMIS ===
Le vocabulaire juridique partage des mots avec le vocabulaire commercial. Ne pas confondre :
- "Offre de transaction" (proposition de règlement amiable d'un litige) ≠ "offre commerciale"
- "Signature LOI / closing" (étape M&A) ≠ "signature newsletter"
- "Conclusions" (acte de procédure) ≠ "conclusion d'article"
- "Mise en demeure" ≠ relance commerciale

=== RÈGLE D'OR ===
DANS LE DOUTE, MARQUE COMME PERTINENT. Si l'email contient une date, un montant > 1000 €, ou une référence (RG, numéro de dossier), TOUJOURS pertinent.

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

    let pertinent = typeof parsed.pertinent === 'boolean' ? parsed.pertinent : true;
    let commentaire = parsed.commentaire || '';

    // Post-LLM safeguard : si LLM dit non-pertinent mais l'email a des marqueurs juridiques
    // évidents (date FR, montant > 1000 €, référence RG), on override. Mieux vaut un faux
    // positif qu'un mail-clé perdu.
    if (!pertinent && hasJuridicalMarkers(subject, bodyPreview)) {
      console.warn('[filter] LLM said non-pertinent but juridical markers found — override to pertinent. Subject:', subject.substring(0, 80));
      pertinent = true;
      commentaire = 'Override safeguard : marqueurs juridiques détectés (date, montant ou référence). LLM avait dit : ' + commentaire;
    }

    return {
      categorie: parsed.categorie || 'prospect',
      pertinent,
      domaine_type: parsed.domaine_type || 'inconnu',
      commentaire
    };
  } catch (e: any) {
    console.error('Filter error:', e.message);
    return fallback;
  }
}
