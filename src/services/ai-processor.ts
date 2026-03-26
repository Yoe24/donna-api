import OpenAI from 'openai';
import { supabase } from '../config/supabase';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface EmailData {
  subject: string;
  sender: string;
  body: string;
  userId: string;
}

export async function processEmailWithAI(emailId: string, emailData: EmailData) {
  console.log('🤖 Starting AI processing for email:', emailId);

  try {
    // Step 1: Extraction
    await updatePipelineStep(emailId, 'extraction_en_cours');
    
    // Extract key information from the email
    const extractedInfo = await extractInformation(emailData.body);
    console.log('📄 Extracted info:', extractedInfo);

    // Step 2: Context search (mini-vault)
    await updatePipelineStep(emailId, 'recherche_contexte');
    
    // Get user's preferred context or use default
    const { data: email } = await supabase
      .from('emails')
      .select('contexte_choisi')
      .eq('id', emailId)
      .single();
    
    const context = email?.contexte_choisi || 'standard';
    console.log('📚 Using context:', context);

    // Step 3: Draft generation
    await updatePipelineStep(emailId, 'redaction_brouillon');
    
    const draft = await generateDraft({
      subject: emailData.subject,
      sender: emailData.sender,
      body: emailData.body,
      extractedInfo,
      context
    });
    
    console.log('✉️ Draft generated:', draft.substring(0, 100) + '...');

    // Step 4: Save draft and mark as ready
    await saveDraftAndMarkReady(emailId, draft, extractedInfo);
    
    console.log('✅ AI processing complete for email:', emailId);

  } catch (error) {
    console.error('❌ AI processing failed:', error);
    // Update status to indicate error
    await supabase
      .from('emails')
      .update({ 
        pipeline_step: 'en_attente',
        statut: 'rejeté'
      })
      .eq('id', emailId);
  }
}

async function updatePipelineStep(emailId: string, step: string) {
  console.log(`⏳ Updating pipeline: ${step}`);
  
  const { error } = await supabase
    .from('emails')
    .update({ pipeline_step: step })
    .eq('id', emailId);

  if (error) {
    console.error('Failed to update pipeline step:', error);
    throw error;
  }

  // Small delay to make the progression visible
  await new Promise(resolve => setTimeout(resolve, 500));
}

async function extractInformation(body: string): Promise<string> {
  // For MVP, do a simple extraction
  // In production, this would use GPT-4o
  const lines = body.split('\n').slice(0, 3);
  return lines.join(' ').substring(0, 200);
}

interface DraftParams {
  subject: string;
  sender: string;
  body: string;
  extractedInfo: string;
  context: string;
}

async function generateDraft(params: DraftParams): Promise<string> {
  const prompt = buildPrompt(params);
  
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `Tu es un assistant juridique expert. Rédige un brouillon de réponse professionnel et adapté au contexte juridique. Le ton doit être formel mais accessible.`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 500,
      store: false,
    });

    return completion.choices[0]?.message?.content || generateFallbackDraft(params);
    
  } catch (error) {
    console.error('OpenAI error:', error);
    return generateFallbackDraft(params);
  }
}

function buildPrompt(params: DraftParams): string {
  return `
Email reçu de: ${params.sender}
Sujet: ${params.subject}
Contexte juridique: ${params.context}

Contenu de l'email:
${params.body.substring(0, 1000)}

Rédige un brouillon de réponse professionnel et adapté. Le brouillon doit:
- Être concis et clair
- Reprendre les points clés de la demande
- Proposer une suite ou une réponse appropriée
- Avoir un ton professionnel mais chaleureux
`;
}

function generateFallbackDraft(params: DraftParams): string {
  return `Bonjour,

J'ai bien reçu votre email concernant "${params.subject}".

Je prends connaissance de votre demande et vous répondrai dans les plus brefs délais.

Cordialement,
[Votre nom]`;
}

async function saveDraftAndMarkReady(
  emailId: string, 
  draft: string, 
  resume: string
) {
  const { error } = await supabase
    .from('emails')
    .update({
      brouillon: draft,
      resume: resume || 'Email analysé',
      pipeline_step: 'pret_a_reviser',
      statut: 'en_attente'
    })
    .eq('id', emailId);

  if (error) {
    console.error('Failed to save draft:', error);
    throw error;
  }
  
  console.log('✅ Draft saved and email marked as ready');
}
