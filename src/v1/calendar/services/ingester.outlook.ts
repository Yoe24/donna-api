// V1 Inbox to Calendar — Phase 2 — ingester.outlook.ts
// Ingest 60 days of Outlook messages + attachments into messages_v1 / attachments_v1.

import { supabase } from '../../../config/supabase';
import { OutlookProvider } from '../../../services/mail/outlook-provider';
import { cleanEmailHtml, cleanForwardChain } from '../utils/text-cleaner';

const DAYS = 60;
const MAX_MESSAGES = 200;

// Reuse or create the v1-attachments bucket (same bucket as Gmail)
let _v1BucketReady = false;
async function ensureV1Bucket(): Promise<void> {
  if (_v1BucketReady) return;
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = (buckets || []).some((b: any) => b.name === 'v1-attachments');
  if (!exists) {
    const { error } = await supabase.storage.createBucket('v1-attachments', {
      public: false,
      fileSizeLimit: 20 * 1024 * 1024,
    });
    if (error) {
      console.error('[v1-outlook] bucket creation error:', error.message);
    } else {
      console.log('[v1-outlook] bucket v1-attachments created');
    }
  }
  _v1BucketReady = true;
}

async function uploadV1Attachment(
  buffer: Buffer,
  userId: string,
  messageId: string,
  filename: string,
  mimeType: string
): Promise<string | null> {
  try {
    await ensureV1Bucket();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${userId}/${messageId}/${safeName}`;
    const { error } = await supabase.storage
      .from('v1-attachments')
      .upload(path, buffer, { contentType: mimeType, upsert: true });
    if (error) {
      console.error('[v1-outlook] upload error:', error.message);
      return null;
    }
    const { data: urlData } = await supabase.storage
      .from('v1-attachments')
      .createSignedUrl(path, 365 * 24 * 3600);
    return urlData?.signedUrl ?? null;
  } catch (err: any) {
    console.error('[v1-outlook] uploadV1Attachment error:', err.message);
    return null;
  }
}

async function extractText(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<{ text: string | null; status: 'ok' | 'corrupt' | 'unsupported' }> {
  const lowerMime = (mimeType || '').toLowerCase();
  const lowerName = (filename || '').toLowerCase();
  const isPdf = lowerMime.includes('pdf') || lowerName.endsWith('.pdf');
  const isDocx =
    lowerMime.includes('wordprocessingml') ||
    lowerMime.includes('msword') ||
    lowerName.endsWith('.docx') ||
    lowerName.endsWith('.doc');

  if (isPdf) {
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return { text: (data.text || '').substring(0, 10000), status: 'ok' };
    } catch (err: any) {
      console.warn('[v1-outlook] pdf-parse error:', err.message);
      return { text: null, status: 'corrupt' };
    }
  }

  if (isDocx) {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return { text: (result.value || '').substring(0, 10000), status: 'ok' };
    } catch (err: any) {
      console.warn('[v1-outlook] mammoth error:', err.message);
      return { text: null, status: 'corrupt' };
    }
  }

  return { text: null, status: 'unsupported' };
}

export async function ingestOutlook60d(userId: string): Promise<{
  messages_count: number;
  attachments_count: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let messages_count = 0;
  let attachments_count = 0;

  // 1. Get outlook_refresh_token from configurations table
  const { data: config, error: configErr } = await supabase
    .from('configurations')
    .select('outlook_refresh_token')
    .eq('user_id', userId)
    .single();

  if (configErr || !config?.outlook_refresh_token) {
    const msg = `[v1-outlook] No Outlook refresh_token for user ${userId}`;
    console.error(msg);
    errors.push(msg);
    return { messages_count, attachments_count, errors };
  }

  // 2. Build Outlook provider
  const provider = new OutlookProvider({ refreshToken: config.outlook_refresh_token, userId });

  // 3. List messages from last 60 days
  const after = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  let processed = 0;

  for await (const rawMsg of provider.listMessagesSince(after, MAX_MESSAGES)) {
    if (processed >= MAX_MESSAGES) break;
    processed++;

    try {
      // 4. Get full message
      const full = await provider.getFullMessage(rawMsg.id);

      // 5. Parse body — OutlookProvider already strips HTML to plain text
      const bodyText = cleanForwardChain(full.body);

      // from_name / from_email
      const fromFull = full.from || '';
      const fromNameMatch = fromFull.match(/^(.+?)\s*<[^>]+>/);
      const fromName = fromNameMatch ? fromNameMatch[1].trim() : null;
      const fromEmail = full.fromEmail || null;

      // to_emails
      const toEmails = full.to
        ? full.to.split(',').map((e: string) => e.trim()).filter(Boolean)
        : [];

      // 6. Upsert into messages_v1
      const { data: msgRow, error: msgErr } = await supabase
        .from('messages_v1')
        .upsert(
          {
            user_id: userId,
            provider: 'outlook',
            external_message_id: rawMsg.id,
            thread_id: rawMsg.threadId || null,
            subject: full.subject || null,
            from_email: fromEmail,
            from_name: fromName,
            to_emails: toEmails.length > 0 ? toEmails : null,
            body_text: bodyText || null,
            body_html: null,
            date_sent: full.date ? full.date.toISOString() : null,
          },
          {
            onConflict: 'user_id,provider,external_message_id',
            ignoreDuplicates: false,
          }
        )
        .select('id')
        .single();

      if (msgErr) {
        const e = `[v1-outlook] upsert messages_v1 error: ${msgErr.message} (msg ${rawMsg.id})`;
        console.error(e);
        errors.push(e);
        continue;
      }

      messages_count++;
      const dbMessageId = msgRow.id;

      // 7. Process attachments
      for (const att of full.attachments) {
        try {
          const buffer = await provider.getAttachment(rawMsg.id, att.id);

          const storageUrl = await uploadV1Attachment(
            buffer,
            userId,
            dbMessageId,
            att.filename,
            att.mimeType
          );

          const { text: textExtracted, status: textStatus } = await extractText(
            buffer,
            att.mimeType,
            att.filename
          );

          const { error: attErr } = await supabase.from('attachments_v1').insert({
            message_id: dbMessageId,
            filename: att.filename,
            mime_type: att.mimeType,
            size_bytes: att.size || null,
            storage_url: storageUrl,
            text_extracted: textExtracted,
            text_extraction_status: textStatus,
          });

          if (attErr) {
            const e = `[v1-outlook] insert attachments_v1 error: ${attErr.message} (${att.filename})`;
            console.error(e);
            errors.push(e);
          } else {
            attachments_count++;
          }
        } catch (attErr: any) {
          const e = `[v1-outlook] attachment processing error: ${attErr.message} (${att.filename})`;
          console.error(e);
          errors.push(e);
        }
      }
    } catch (msgErr: any) {
      const e = `[v1-outlook] message processing error: ${msgErr.message} (id ${rawMsg.id})`;
      console.error(e);
      errors.push(e);
    }
  }

  console.log(`[v1-outlook] ingest complete: ${messages_count} messages, ${attachments_count} attachments, ${errors.length} errors`);
  return { messages_count, attachments_count, errors };
}
