import OpenAI from 'openai';
import { DraftResult, Annotation } from '../../types';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const DRAFT_PROMPT = (style: string) => `Tu es La Plume, un avocat français expert en rédaction de réponses professionnelles.

STYLE DE RÉDACTION: ${style === 'formal' ? 'Formel et protocolaire' : style === 'casual' ? 'Professionnel mais décontracté' : 'Direct et concis'}

TA MISSION:
1. Rédiger une réponse professionnelle à l'email reçu
2. Inclure des annotations [1], [2], [⚠️], [📅] pour les sources/warnings/délais
3. Produire un JSON structuré

RÈGLES DE RÉDACTION:
- En français, impeccable
- Ton adapté au style demandé
- Structure claire: salutation, corps, formule de politesse
- Proposer des actions concrètes quand pertinent

ANNOTATIONS À INCLURE:
- [1], [2], [3]... : Sources juridiques citées (articles, codes, jurisprudence)
- [⚠️] : Points de vigilance, risques
- [📅] : Dates importantes, délais
- [?] : Questions à clarifier avec le client

FORMAT DE RÉPONSE JSON:
{
  "to": "email@destinataire.com",
  "subject": "RE: Objet original",
  "body": "Madame, Monsieur,[\\n\\n]Corps de la réponse avec annotations[1] intégrées[⚠️]...[\\n\\n]Cordialement",
  "annotations": [
    {"type": "source", "text": "Article 1234 du Code civil", "confidence": 0.95, "ref": "[1]"},
    {"type": "warning", "text": "Délai de prescription expire le 15/03", "severity": "high", "ref": "[⚠️]"},
    {"type": "deadline", "text": "Audience fixée au 20/03 à 14h", "ref": "[📅]"}
  ]
}`;

export async function generateDraft(
  emailSubject: string,
  emailBody: string,
  fromEmail: string,
  lawyerStyle: string = 'formal'
): Promise<DraftResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: DRAFT_PROMPT(lawyerStyle) },
      {
        role: 'user',
        content: `Email à répondre:\nDe: ${fromEmail}\nObjet: ${emailSubject}\n\nCorps:\n${emailBody.substring(0, 6000)}`,
      },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
    store: false,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenAI');
  }

  const result = JSON.parse(content);

  // Ensure annotations is an array
  const annotations: Annotation[] = Array.isArray(result.annotations) 
    ? result.annotations 
    : [];

  return {
    to: result.to || fromEmail,
    subject: result.subject || `RE: ${emailSubject}`,
    body: result.body,
    annotations,
  };
}
