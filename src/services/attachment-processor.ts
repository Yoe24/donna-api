import https from "https";
import { parse as urlParse } from "url";
import { supabase } from "../config/supabase";
import OpenAI from "openai";

interface HttpsGetResponse {
  statusCode: number | undefined;
  body: Buffer;
}

interface Attachment {
  attachment_id?: string;
  filename: string;
  content_type?: string;
}

interface ExtractedAttachment {
  filename: string;
  text: string;
  buffer: Buffer;
}

function httpsGet(url: string, headers: Record<string, string>): Promise<HttpsGetResponse> {
  return new Promise((resolve, reject) => {
    const opts = Object.assign(urlParse(url), { headers });
    const req = https.get(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return data.text ? data.text.substring(0, 8000) : "";
  } catch (e: any) {
    console.error("pdf-parse error:", e.message);
    return "";
  }
}

async function extractWordText(buffer: Buffer): Promise<string> {
  try {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value ? result.value.substring(0, 8000) : "";
  } catch (e: any) {
    console.error("mammoth error:", e.message);
    return "";
  }
}

// === Ensure the "attachments" bucket exists in Supabase Storage ===
let _bucketReady = false;

export async function ensureBucket(): Promise<void> {
  if (_bucketReady) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const exists = (buckets || []).some((b: any) => b.name === "attachments");
    if (!exists) {
      const { error } = await supabase.storage.createBucket("attachments", {
        public: false,
        fileSizeLimit: 20 * 1024 * 1024, // 20MB max
      });
      if (error) {
        console.error("Bucket creation error:", error.message);
      } else {
        console.log("Supabase Storage bucket 'attachments' created");
      }
    }
    _bucketReady = true;
  } catch (e: any) {
    console.error("ensureBucket error:", e.message);
  }
}

// === Upload a file buffer to Supabase Storage ===
// Returns the public URL or null
export async function uploadToStorage(
  buffer: Buffer,
  userId: string,
  dossierId: string,
  filename: string
): Promise<string | null> {
  try {
    await ensureBucket();
    // Sanitize filename to avoid path issues
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = userId + "/" + dossierId + "/" + safeName;

    // Detect content type
    let contentType = "application/octet-stream";
    const lower = filename.toLowerCase();
    if (lower.endsWith(".pdf")) contentType = "application/pdf";
    else if (lower.endsWith(".docx")) contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    else if (lower.endsWith(".doc")) contentType = "application/msword";

    const { data, error } = await supabase.storage
      .from("attachments")
      .upload(storagePath, buffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.error("Storage upload error for " + filename + ":", error.message);
      return null;
    }

    // Get signed URL (valid 1 year)
    const { data: urlData } = await supabase.storage
      .from("attachments")
      .createSignedUrl(storagePath, 365 * 24 * 3600);

    const url = urlData ? urlData.signedUrl : null;
    console.log("Uploaded to storage: " + storagePath);
    return url;
  } catch (e: any) {
    console.error("uploadToStorage error:", e.message);
    return null;
  }
}

// === Generate a short IA summary of document content ===
export async function generateAttachmentSummary(
  contenuExtrait: string,
  filename: string
): Promise<string | null> {
  if (!contenuExtrait || contenuExtrait.trim().length === 0) return null;
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const truncated = contenuExtrait.substring(0, 3000);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      store: false,
      messages: [
        {
          role: "system",
          content:
            "Tu es Donna, une secrétaire juridique factuelle. Résume ce document en 1-2 lignes. Indique uniquement : quel type de document c'est, de qui il émane, quelles informations clés il contient. Ne donne AUCUN conseil juridique.",
        },
        {
          role: "user",
          content:
            "Fichier : " +
            filename +
            "\n\nContenu du document :\n" +
            truncated +
            "\n\nRéponds en texte brut, 1-2 lignes maximum.",
        },
      ],
      temperature: 0.1,
      max_tokens: 150,
    });

    const summary = (completion.choices[0].message.content || "").trim();
    console.log("Attachment summary generated for " + filename + ": " + summary.substring(0, 80) + "...");
    return summary;
  } catch (e: any) {
    console.error("generateAttachmentSummary error:", e.message);
    return null;
  }
}

export async function extractAttachmentsText(
  messageId: string,
  attachments: Attachment[],
  bufferOverride?: Buffer
): Promise<ExtractedAttachment[]> {
  if (!attachments || attachments.length === 0) return [];

  // If a buffer is provided directly (Gmail flow), use it instead of fetching from AgentMail
  if (bufferOverride) {
    const results: ExtractedAttachment[] = [];
    for (const att of attachments) {
      const { filename, content_type } = att;
      const isPdf =
        (content_type && content_type.includes("pdf")) ||
        (filename && filename.toLowerCase().endsWith(".pdf"));
      const isWord =
        (content_type &&
          (content_type.includes("wordprocessingml") || content_type.includes("msword"))) ||
        (filename &&
          (filename.toLowerCase().endsWith(".docx") || filename.toLowerCase().endsWith(".doc")));
      if (!isPdf && !isWord) continue;
      try {
        let text = "";
        if (isPdf) text = await extractPdfText(bufferOverride);
        else if (isWord) text = await extractWordText(bufferOverride);
        if (text.trim().length > 0) {
          results.push({ filename, text, buffer: bufferOverride });
        }
      } catch (e: any) {
        console.error(`Error processing attachment ${filename}:`, e.message);
      }
    }
    return results;
  }

  // AgentMail flow -- fetch from API
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    console.error("AGENTMAIL_API_KEY not set");
    return [];
  }

  const results: ExtractedAttachment[] = [];

  for (const att of attachments) {
    const { attachment_id, filename, content_type } = att;
    const isPdf =
      (content_type && content_type.includes("pdf")) ||
      (filename && filename.toLowerCase().endsWith(".pdf"));
    const isWord =
      (content_type &&
        (content_type.includes("wordprocessingml") || content_type.includes("msword"))) ||
      (filename &&
        (filename.toLowerCase().endsWith(".docx") || filename.toLowerCase().endsWith(".doc")));

    if (!isPdf && !isWord) {
      console.log(`Skipping attachment (unsupported type): ${filename}`);
      continue;
    }

    try {
      console.log(`Fetching attachment: ${filename} (${attachment_id})`);
      const url = `https://api.agentmail.to/v0/messages/${messageId}/attachments/${attachment_id}`;
      const { statusCode, body } = await httpsGet(url, {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/octet-stream",
      });

      if (statusCode !== 200) {
        console.error(`Failed to fetch attachment ${filename}: HTTP ${statusCode}`);
        continue;
      }

      let text = "";
      if (isPdf) {
        text = await extractPdfText(body);
      } else if (isWord) {
        text = await extractWordText(body);
      }

      if (text.trim().length > 0) {
        console.log(`Extracted ${text.length} chars from ${filename}`);
        results.push({ filename, text, buffer: body });
      } else {
        console.warn(`Empty text extracted from ${filename}`);
      }
    } catch (e: any) {
      console.error(`Error processing attachment ${filename}:`, e.message);
    }
  }

  return results;
}
