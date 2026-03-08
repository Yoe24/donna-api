import OpenAI from 'openai';
import { ClassificationResult, EmailCategory } from '../../types';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CLASSIFICATION_PROMPT = `Tu es Le Facteur, un expert en analyse d'emails juridiques français.
Ta mission : classifier les emails entrants en 4 catégories uniquement.

CATÉGORIES:
- "pro_action" : Email professionnel nécessitant une action/une réponse (client, tribunal, confrère, administration)
- "pro_info" : Email professionnel informatif sans action requise (newsletters juridiques, infos cabinet)
- "perso" : Email personnel de l'avocat
- "spam" : Spam, phishing, newsletters non professionnelles

RÈGLES:
- Réponds UNIQUEMENT en JSON
- Incluis un score de confiance entre 0 et 1
- Sois conservateur : si doute, mets "pro_action"

FORMAT DE RÉPONSE:
{
  "category": "pro_action|pro_info|perso|spam",
  "confidence": 0.95,
  "reasoning": "brève explication"
}`;

export async function classifyEmail(
  subject: string,
  body: string
): Promise<ClassificationResult> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: CLASSIFICATION_PROMPT },
      { 
        role: 'user', 
        content: `Objet: ${subject}\n\nCorps:\n${body.substring(0, 4000)}` // Limit to avoid token overflow
      },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenAI');
  }

  const result = JSON.parse(content);
  
  return {
    category: result.category as EmailCategory,
    confidence: result.confidence,
    reasoning: result.reasoning,
  };
}
