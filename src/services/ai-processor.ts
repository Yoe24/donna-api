import OpenAI from 'openai';
import { supabase } from '../config/supabase';
import { filterEmail } from './agents/agent-filter';
import { getEmailContext } from './agents/agent-context';
import { draftResponse } from './agents/agent-drafter';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface EmailData {
  subject: string;
  sender: string;
  body: string;
  userId: string;
  attachmentsText?: Array<{ filename: string; text: string }>;
  attachments?: any[];
  messageId?: string | null;
}

function extractEmailAddress(sender: string): string {
  const match = sender.match(/<([^>]+)>/);
  return match ? match[1].trim().toLowerCase() : sender.trim().toLowerCase();
}

function extractSenderName(sender: string): string {
  const match = sender.match(/^([^<]+)</);
  if (match) return match[1].trim();
  const atIndex = sender.indexOf('@');
  if (atIndex > 0) return sender.substring(0, atIndex);
  return sender;
}

export async function processEmailWithAI(emailId: string, emailData: EmailData) {
  console.log('Starting AI processing for email:', emailId);
  try {
    // Step 1: Filtrage (agent-filter)
    await updatePipelineStep(emailId, 'filtrage_en_cours');
    const filterResult = await filterEmail({
      subject: emailData.subject,
      sender: emailData.sender,
      bodyPreview: (emailData.body || '').substring(0, 300),
      userId: emailData.userId,
    });
    console.log('Filter result:', filterResult.categorie, '| pertinent:', filterResult.pertinent);

    if (!filterResult.pertinent) {
      console.log('Email non pertinent — ignoré:', emailData.subject);
      await supabase
        .from('emails')
        .update({
          pipeline_step: 'ignore',
          statut: 'ignore',
          resume: 'Email ignoré par le filtre : ' + (filterResult.commentaire || 'non pertinent'),
          urgency: 'low',
          needs_response: false,
          classification: { email_type: 'autre', urgency: 'low', needs_response: false, summary: filterResult.commentaire || 'Non pertinent' },
          is_processed: true,
        })
        .eq('id', emailId);
      return;
    }

    // Step 2: Archivage (logique archiviste)
    await updatePipelineStep(emailId, 'archivage_en_cours');
    const senderEmail = extractEmailAddress(emailData.sender);
    const senderName = extractSenderName(emailData.sender);
    const dossierId = await archiveEmail(emailId, senderEmail, senderName, emailData.userId);

    // Step 3: Recherche de contexte (agent-context)
    await updatePipelineStep(emailId, 'recherche_contexte');
    const context = await getEmailContext({
      senderEmail,
      userId: emailData.userId,
    });
    console.log('Context loaded:', context.dossier ? (context.dossier as any).nom_client : 'aucun dossier');

    // Step 4: Charger la config du cabinet
    const config = await loadConfig(emailData.userId);

    // Step 5: Génération résumé + recommandation (agent-drafter)
    await updatePipelineStep(emailId, 'redaction_brouillon');
    const draft = await draftResponse({
      emailData: {
        sender: emailData.sender,
        subject: emailData.subject,
        body: emailData.body || '',
        attachmentsText: emailData.attachmentsText || [],
      },
      context: context as any,
      config,
    });
    console.log('Résumé + recommandation générés, longueur:', draft.length);

    // Step 6: Extraire le résumé court
    const resumeShort = extractShortResume(draft, emailData.subject);

    // Step 7: Sauvegarder et marquer comme prêt
    await supabase
      .from('emails')
      .update({
        brouillon: draft,
        resume: resumeShort,
        pipeline_step: 'pret_a_reviser',
        statut: 'en_attente',
        dossier_id: dossierId,
      })
      .eq('id', emailId);

    // Step 8: Classification enrichie
    await enrichEmailClassification(emailId, emailData);

    console.log('AI processing complete for email:', emailId);
  } catch (error: any) {
    console.error('AI processing failed:', error);
    await supabase
      .from('emails')
      .update({
        pipeline_step: 'en_attente',
        statut: 'en_attente',
        resume: 'Erreur de traitement : ' + (error.message || 'erreur inconnue'),
      })
      .eq('id', emailId);
  }
}

async function archiveEmail(emailId: string, senderEmail: string, senderName: string, userId: string): Promise<string | null> {
  try {
    const { data: existingDossiers, error: lookupError } = await supabase
      .from('dossiers')
      .select('id, nom_client')
      .eq('user_id', userId)
      .ilike('email_client', senderEmail)
      .limit(1);

    if (lookupError) {
      console.error('Archiviste: erreur lookup dossier:', lookupError.message);
      return null;
    }

    let dossierId: string;

    if (existingDossiers && existingDossiers.length > 0) {
      dossierId = existingDossiers[0].id;
      const { error: updateError } = await supabase
        .from('dossiers')
        .update({
          dernier_echange_date: new Date().toISOString(),
          dernier_echange_par: senderEmail,
        })
        .eq('id', dossierId);

      if (updateError) {
        console.error('Archiviste: erreur update dossier:', updateError.message);
      } else {
        console.log('Dossier existant mis à jour pour ' + existingDossiers[0].nom_client + ' (id: ' + dossierId + ')');
      }
    } else {
      const { data: newDossier, error: insertError } = await supabase
        .from('dossiers')
        .insert({
          user_id: userId,
          nom_client: senderName,
          email_client: senderEmail,
          statut: 'actif',
          domaine: null,
          dernier_echange_date: new Date().toISOString(),
          dernier_echange_par: senderEmail,
        })
        .select('id')
        .single();

      if (insertError) {
        console.error('Archiviste: erreur création dossier:', insertError.message);
        return null;
      }
      dossierId = newDossier.id;
      console.log('Nouveau dossier créé pour ' + senderName + ' (' + senderEmail + ') — id: ' + dossierId);
    }

    const { error: emailUpdateError } = await supabase
      .from('emails')
      .update({ dossier_id: dossierId })
      .eq('id', emailId);

    if (emailUpdateError) {
      console.error('Archiviste: erreur association email-dossier:', emailUpdateError.message);
    }

    return dossierId;
  } catch (e: any) {
    console.error('Archiviste: erreur inattendue:', e.message);
    return null;
  }
}

async function loadConfig(userId: string): Promise<any> {
  try {
    const { data, error } = await supabase
      .from('configurations')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      console.warn('Config non trouvée, utilisation des valeurs par défaut');
      return null;
    }
    return data;
  } catch (e: any) {
    console.warn('Erreur chargement config:', e.message);
    return null;
  }
}

function extractShortResume(draft: string, subject: string): string {
  const match = draft.match(/📋\s*Résumé de la situation\s*:\s*\n([\s\S]*?)(?=\n🎯|$)/);
  if (match && match[1]) {
    return match[1].trim().substring(0, 500);
  }
  return 'Email analysé : ' + (subject || '(sans sujet)');
}

async function enrichEmailClassification(emailId: string, emailData: EmailData) {
  try {
    console.log('Enrichissement classification pour:', emailId);

    const bodyPreview = (emailData.body || '').substring(0, 2000);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Tu es Donna, secrétaire juridique numérique. Analyse cet email et renvoie UNIQUEMENT un JSON valide :\n{\n  "email_type": "relance|convocation|piece_jointe|information|demande|facture|autre",\n  "urgency": "high|medium|low",\n  "needs_response": true/false,\n  "client_name": "nom ou null",\n  "opposing_party": "partie adverse ou null",\n  "case_reference": "référence RG ou null",\n  "key_dates": ["YYYY-MM-DD — description"],\n  "summary": "Résumé factuel en 2 phrases de ce qui est dans cet email",\n  "fait_nouveau": "Ce qui est nouveau dans cet email, en 1 phrase factuelle"\n}'
        },
        {
          role: 'user',
          content: 'Email :\nDe: ' + (emailData.sender || '') + '\nObjet: ' + (emailData.subject || '') + '\nCorps: ' + bodyPreview
        }
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      store: false,
    });

    const raw = (completion.choices[0].message.content || '').trim();
    const parsed = JSON.parse(raw);

    const urgency = ['high', 'medium', 'low'].indexOf(parsed.urgency) >= 0 ? parsed.urgency : 'medium';
    const needsResponse = typeof parsed.needs_response === 'boolean' ? parsed.needs_response : true;

    const { error: updateErr } = await supabase
      .from('emails')
      .update({
        urgency,
        needs_response: needsResponse,
        classification: parsed,
        is_processed: true,
      })
      .eq('id', emailId);

    if (updateErr) {
      console.error('Enrichissement update error:', updateErr.message);
    } else {
      console.log('Classification enrichie:', urgency, '| needs_response:', needsResponse, '| type:', parsed.email_type);
    }
  } catch (e: any) {
    console.error('Enrichissement error (non bloquant):', e.message);
    await supabase
      .from('emails')
      .update({ is_processed: true })
      .eq('id', emailId);
  }
}

async function updatePipelineStep(emailId: string, step: string) {
  console.log('Pipeline step: ' + step);
  const { error } = await supabase
    .from('emails')
    .update({ pipeline_step: step })
    .eq('id', emailId);
  if (error) {
    console.error('Failed to update pipeline step:', error);
    throw error;
  }
  await new Promise(resolve => setTimeout(resolve, 300));
}
