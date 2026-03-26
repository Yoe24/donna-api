import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

interface Config {
  nom_avocat?: string;
  nom_cabinet?: string;
  specialite?: string;
}

interface AttachmentText {
  filename: string;
  text: string;
}

interface EmailData {
  sender: string;
  subject: string;
  body: string;
  attachmentsText?: AttachmentText[];
}

interface Context {
  dossier?: {
    nom_client?: string;
    domaine?: string;
    resume_situation?: string;
  };
  emails_recents?: Array<{
    created_at?: string;
    objet?: string;
    resume?: string;
  }>;
  documents_recents?: Array<{
    nom_fichier: string;
    date_reception?: string;
    contenu_extrait?: string;
  }>;
}

function buildSystemPrompt(config?: Config): string {
  const cabinet = config
    ? 'Tu es Donna, l\'assistante juridique IA de ' + config.nom_avocat + ', cabinet ' + (config.nom_cabinet || '') + ', spécialisé en ' + (config.specialite || 'droit') + '.'
    : 'Tu es Donna, l\'assistante juridique IA d\'une avocate française.';
  return cabinet + '\n\n' +
    'TON RÔLE : Analyser les emails entrants et produire un RÉSUMÉ + RECOMMANDATION pour aider l\'avocate à prioriser et agir vite. Tu ne rédiges PAS de brouillon de réponse.\n\n' +
    'RÈGLES ANTI-HALLUCINATION IMPÉRATIVES :\n' +
    '1. Tu ne peux utiliser QUE les documents, emails et informations fournis dans ce contexte.\n' +
    '2. Si une information n\'est pas dans le contexte, dis-le EXPLICITEMENT plutôt que de l\'inventer.\n' +
    '3. Ne cite JAMAIS de jurisprudence, numéro d\'article de loi ou référence légale sauf s\'ils sont présents mot pour mot dans les documents fournis.\n' +
    '4. En cas de doute sur un fait, écris "[À VÉRIFIER]" plutôt que d\'affirmer.\n' +
    '5. Base tes recommandations UNIQUEMENT sur les éléments factuels du contexte.\n\n' +
    'Tu réponds toujours en français. Tu produis une analyse factuelle, concrète et actionnable.';
}

function buildUserPrompt(emailData: EmailData, context: Context, _config?: Config): string {
  let prompt = '=== EMAIL ENTRANT ===\n';
  prompt += 'De : ' + emailData.sender + '\n';
  prompt += 'Sujet : ' + emailData.subject + '\n';
  prompt += 'Corps :\n' + (emailData.body || '(corps vide)') + '\n';

  if (emailData.attachmentsText && emailData.attachmentsText.length > 0) {
    prompt += '\n=== PIÈCES JOINTES ===\n';
    emailData.attachmentsText.forEach(function(att) {
      prompt += '--- ' + att.filename + ' ---\n' + att.text + '\n';
    });
  }

  if (context.dossier) {
    prompt += '\n=== DOSSIER CLIENT ===\n';
    prompt += 'Client : ' + (context.dossier.nom_client || 'inconnu') + '\n';
    prompt += 'Domaine : ' + (context.dossier.domaine || 'non précisé') + '\n';
    prompt += 'Situation : ' + (context.dossier.resume_situation || 'non précisée') + '\n';
  } else {
    prompt += '\n=== DOSSIER CLIENT ===\nAucun dossier existant pour cet expéditeur.\n';
  }

  if (context.emails_recents && context.emails_recents.length > 0) {
    prompt += '\n=== DERNIERS EMAILS DU DOSSIER ===\n';
    context.emails_recents.forEach(function(e, i) {
      const d = e.created_at ? new Date(e.created_at).toLocaleDateString('fr-FR') : 'date inconnue';
      prompt += (i + 1) + '. [' + d + '] ' + (e.objet || '(sans sujet)') + '\n';
      if (e.resume) prompt += '   Résumé : ' + e.resume.substring(0, 200) + '\n';
    });
  }

  if (context.documents_recents && context.documents_recents.length > 0) {
    prompt += '\n=== DOCUMENTS DU DOSSIER ===\n';
    context.documents_recents.forEach(function(doc) {
      const d = doc.date_reception ? new Date(doc.date_reception).toLocaleDateString('fr-FR') : 'date inconnue';
      prompt += '--- ' + doc.nom_fichier + ' (' + d + ') ---\n';
      if (doc.contenu_extrait) prompt += doc.contenu_extrait.substring(0, 1000) + '\n';
    });
  }

  prompt += '\n=== INSTRUCTIONS ===\n';
  prompt += 'Analyse cet email et produis STRICTEMENT le format suivant :\n\n';
  prompt += '📋 Résumé de la situation :\n';
  prompt += '[3-5 lignes maximum. Résumer qui écrit, pourquoi, quel est le contexte juridique, quelles pièces sont jointes ou mentionnées]\n\n';
  prompt += '🎯 Recommandation Donna :\n';
  prompt += '[1-3 actions concrètes que l\'avocate devrait faire.]\n\n';
  prompt += '💡 Points d\'attention :\n';
  prompt += '[Ce que l\'avocate doit vérifier elle-même, ce que Donna ne peut pas garantir, les [À VÉRIFIER] éventuels]';

  return prompt;
}

function fallbackDraft(emailData: EmailData): string {
  return '📋 Résumé de la situation :\nEmail reçu concernant "' + (emailData.subject || 'votre demande') + '". Analyse automatique indisponible.\n\n' +
    '🎯 Recommandation Donna :\n- Lire l\'email manuellement et traiter selon l\'urgence\n\n' +
    '💡 Points d\'attention :\nCe résumé est un fallback automatique — l\'analyse IA n\'a pas pu être générée.';
}

interface DraftInput {
  emailData: EmailData;
  context: Context;
  config?: Config;
}

export async function draftResponse({ emailData, context, config }: DraftInput): Promise<string> {
  try {
    const systemPrompt = buildSystemPrompt(config);
    const userPrompt = buildUserPrompt(emailData, context, config);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 2000,
      store: false,
    });

    const result = completion.choices[0].message.content || fallbackDraft(emailData);
    console.log('agent-drafter: résumé + recommandation générés, longueur:', result.length);
    return result;
  } catch (e: any) {
    console.error('agent-drafter: erreur OpenAI:', e.message);
    return fallbackDraft(emailData);
  }
}
