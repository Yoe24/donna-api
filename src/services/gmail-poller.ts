// src/services/gmail-poller.ts
// Mail poller — handles both Gmail and Outlook providers.
// Filename kept as gmail-poller.ts to avoid changing src/index.ts import.
// Exported function: startGmailPolling (alias for startMailPolling for backward compat).

import { supabase } from '../config/supabase';
import { processEmailWithAI } from './ai-processor';
import { uploadToStorage, generateAttachmentSummary } from './attachment-processor';
import { GmailProvider } from './mail/gmail-provider';
import { OutlookProvider } from './mail/outlook-provider';
import { TokenInvalidError, MailProvider } from './mail/types';

const POLL_INTERVAL = 30000; // 30 secondes

let pdf_parse: any;
let mammoth: any;
try { pdf_parse = require('pdf-parse'); } catch { /* not available */ }
try { mammoth = require('mammoth'); } catch { /* not available */ }

let pollingTimer: ReturnType<typeof setInterval> | null = null;

interface ExtractedText {
  filename: string;
  text: string;
}

// ─── Attachment processing (provider-agnostic) ───────────────────────────────

async function processProviderAttachments(
  provider: MailProvider,
  providerMsgId: string,
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>,
  dossierId: string | null,
  emailId: string | null,
  userId: string
): Promise<ExtractedText[]> {
  const extractedTexts: ExtractedText[] = [];
  for (const att of attachments) {
    try {
      const ct = (att.mimeType || '').toLowerCase();
      const isPdf = ct.includes('pdf') || att.filename.toLowerCase().endsWith('.pdf');
      const isWord = ct.includes('wordprocessingml') || ct.includes('msword')
        || att.filename.toLowerCase().endsWith('.docx')
        || att.filename.toLowerCase().endsWith('.doc');

      if (!isPdf && !isWord) continue;

      const buffer = await provider.getAttachment(providerMsgId, att.id);
      let extractedText = '';

      if (isPdf && pdf_parse) {
        const pdfData = await pdf_parse(buffer);
        extractedText = (pdfData.text || '').substring(0, 10000);
      } else if (isWord && mammoth) {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = (result.value || '').substring(0, 10000);
      }

      let storageUrl: string | null = null;
      if (dossierId && userId) {
        storageUrl = await uploadToStorage(buffer, userId, dossierId, att.filename);
      }

      let resumeIa: string | null = null;
      if (extractedText) {
        resumeIa = await generateAttachmentSummary(extractedText, att.filename);
      }

      if (dossierId) {
        const docRow: any = {
          dossier_id: dossierId,
          email_id: emailId || null,
          nom_fichier: att.filename,
          type: isPdf ? 'pdf' : 'word',
          contenu_extrait: extractedText || null,
          date_reception: new Date().toISOString(),
          storage_url: storageUrl || null,
          resume_ia: resumeIa || null,
        };
        const { error: docInsertErr } = await supabase.from('dossier_documents').insert(docRow);
        if (docInsertErr?.message) {
          if (docInsertErr.message.includes('email_id')) delete docRow.email_id;
          if (docInsertErr.message.includes('storage_url')) delete docRow.storage_url;
          if (docInsertErr.message.includes('resume_ia')) delete docRow.resume_ia;
          await supabase.from('dossier_documents').insert(docRow);
        }
      }

      if (extractedText) {
        extractedTexts.push({ filename: att.filename, text: extractedText });
        console.log(`📎 PJ ${provider.name} extraite : ${att.filename} — ${extractedText.length} car.` +
          (storageUrl ? ' (stocké)' : '') + (resumeIa ? ' (résumé)' : ''));
      }
    } catch (err: any) {
      console.error(`❌ Erreur PJ ${provider.name} ${att.filename || 'inconnue'} :`, err.message);
    }
  }
  return extractedTexts;
}

// ─── Per-user polling ─────────────────────────────────────────────────────────

async function checkNewEmailsForUser(
  userId: string,
  provider: MailProvider,
  lastCheck: string | null,
  providerName: 'gmail' | 'outlook'
): Promise<void> {
  const metadataKey = providerName === 'gmail' ? 'gmail_message_id' : 'outlook_message_id';
  const lastCheckField = providerName === 'gmail' ? 'gmail_last_check' : 'outlook_last_check';

  let sinceDate: Date;
  if (lastCheck) {
    sinceDate = new Date(lastCheck);
  } else {
    sinceDate = new Date(Date.now() - 3600000);
  }

  let newCount = 0;

  for await (const rawMsg of provider.listMessagesSince(sinceDate, 50)) {
    try {
      const { data: existing } = await supabase
        .from('emails')
        .select('id')
        .eq('user_id', userId)
        .contains('metadata', { [metadataKey]: rawMsg.id })
        .limit(1);

      if (existing && existing.length > 0) continue;

      const full = await provider.getFullMessage(rawMsg.id);

      const { data: email, error: insertError } = await supabase
        .from('emails')
        .insert({
          user_id: userId,
          expediteur: full.from,
          objet: full.subject,
          resume: null,
          brouillon: null,
          pipeline_step: 'en_attente',
          statut: 'en_attente',
          contexte_choisi: 'standard',
          metadata: { [metadataKey]: rawMsg.id },
        })
        .select()
        .single();

      if (insertError) {
        console.error(`❌ ${providerName} poll insert error:`, insertError.message);
        continue;
      }

      console.log(`📬 Nouvel email ${providerName} (user ${userId.substring(0, 8)}): ${full.subject} (de ${full.from})`);

      processEmailWithAI(email.id, {
        subject: full.subject,
        sender: full.from,
        body: full.body,
        userId,
        attachments: [],
        messageId: null,
      }).then(async () => {
        if (full.attachments.length > 0) {
          try {
            const { data: updatedEmail } = await supabase
              .from('emails')
              .select('dossier_id')
              .eq('id', email.id)
              .single();
            const dossierId = updatedEmail?.dossier_id || null;
            await processProviderAttachments(provider, rawMsg.id, full.attachments, dossierId, email.id, userId);
          } catch (attErr: any) {
            console.error(`❌ ${providerName} poll attachment error:`, attErr.message);
          }
        }
      }).catch((err: any) => {
        console.error(`❌ AI processing error (${providerName} poll):`, err.message);
      });

      newCount++;
    } catch (msgErr: any) {
      if (msgErr instanceof TokenInvalidError) throw msgErr; // bubble up
      console.error(`❌ ${providerName} poll message error:`, msgErr.message);
    }
  }

  await supabase
    .from('configurations')
    .update({ [lastCheckField]: new Date().toISOString() })
    .eq('user_id', userId);

  if (newCount > 0) {
    console.log(`📬 ${providerName} poll (user ${userId.substring(0, 8)}): ${newCount} nouveaux emails traités`);
  }
}

// ─── Main poll cycle ──────────────────────────────────────────────────────────

async function checkAllUsers(): Promise<void> {
  try {
    const { data: configs, error } = await supabase
      .from('configurations')
      .select('user_id, provider, refresh_token, gmail_last_check, outlook_refresh_token, outlook_last_check');

    if (error || !configs || configs.length === 0) return;

    for (const config of configs) {
      const providerName: 'gmail' | 'outlook' = config.provider === 'outlook' ? 'outlook' : 'gmail';

      if (providerName === 'gmail') {
        if (!config.refresh_token) continue;

        const provider = new GmailProvider({ refreshToken: config.refresh_token, userId: config.user_id });
        try {
          await checkNewEmailsForUser(config.user_id, provider, config.gmail_last_check, 'gmail');
        } catch (err: any) {
          if (err instanceof TokenInvalidError) {
            console.warn(`⚠️ Gmail poll: token invalide pour user ${config.user_id.substring(0, 8)} — flag gmail_needs_reconnect levé`);
            await supabase
              .from('configurations')
              .update({ refresh_token: null, gmail_needs_reconnect: true })
              .eq('user_id', config.user_id);
          } else {
            console.error(`❌ Gmail poll error (user ${config.user_id.substring(0, 8)}):`, err.message);
          }
        }
      } else {
        // Outlook
        if (!config.outlook_refresh_token) continue;

        const provider = new OutlookProvider({ refreshToken: config.outlook_refresh_token, userId: config.user_id });
        try {
          await checkNewEmailsForUser(config.user_id, provider, config.outlook_last_check, 'outlook');
        } catch (err: any) {
          if (err instanceof TokenInvalidError) {
            console.warn(`⚠️ Outlook poll: token invalide pour user ${config.user_id.substring(0, 8)} — flag outlook_needs_reconnect levé`);
            await supabase
              .from('configurations')
              .update({ outlook_refresh_token: null, outlook_needs_reconnect: true })
              .eq('user_id', config.user_id);
          } else {
            console.error(`❌ Outlook poll error (user ${config.user_id.substring(0, 8)}):`, err.message);
          }
        }
      }
    }
  } catch (err: any) {
    console.error('❌ Poll global error:', err.message);
  }
}

// ─── Exported functions ───────────────────────────────────────────────────────

export async function startMailPolling(): Promise<void> {
  console.log('📬 Mail polling initialisé (toutes les 30s) — multi-providers, multi-utilisateurs');

  try {
    const { data: configs } = await supabase
      .from('configurations')
      .select('user_id, provider, refresh_token, outlook_refresh_token');

    const activeCount = (configs || []).filter(
      (c: any) => (c.provider === 'outlook' ? c.outlook_refresh_token : c.refresh_token)
    ).length;

    if (activeCount === 0) {
      console.log('📬 Aucun token trouvé — polling en attente (vérifiera toutes les 60s)');
      pollingTimer = setInterval(async () => {
        const { data: c } = await supabase
          .from('configurations')
          .select('user_id, provider, refresh_token, outlook_refresh_token');
        const active = (c || []).filter(
          (cfg: any) => (cfg.provider === 'outlook' ? cfg.outlook_refresh_token : cfg.refresh_token)
        );
        if (active.length > 0) {
          console.log(`📬 ${active.length} token(s) détecté(s) — démarrage du polling`);
          clearInterval(pollingTimer!);
          pollingTimer = setInterval(checkAllUsers, POLL_INTERVAL);
          checkAllUsers();
        }
      }, 60000);
      return;
    }

    console.log(`📬 ${activeCount} utilisateur(s) avec token — démarrage du polling`);
    pollingTimer = setInterval(checkAllUsers, POLL_INTERVAL);
    checkAllUsers();
  } catch (err: any) {
    console.error('❌ Mail polling init error:', err.message);
  }
}

// Backward-compat alias — src/index.ts imports startGmailPolling
export const startGmailPolling = startMailPolling;
