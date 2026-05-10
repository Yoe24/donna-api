/**
 * DriveExporter — mirrors Donna's attachments into Google Drive.
 *
 * Scope used: drive.file (only files/folders created by our app).
 * This is the least-permissive scope that allows folder creation + file upload.
 *
 * Idempotent: if drive_folder_id / drive_file_id is already set and the
 * remote resource still exists, the method is a no-op.
 *
 * All errors are caught and logged — never thrown to the caller — so the
 * pipeline continues even when Drive is unavailable.
 */

import { google } from 'googleapis';
import { supabase } from '../config/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AttachmentRow {
  id: string;
  dossier_id: string;
  nom_fichier: string;
  storage_url: string | null;
  drive_file_id: string | null;
}

// ─── OAuth2 client factory ────────────────────────────────────────────────────

function makeOAuth2Client(refreshToken: string) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Download a file from a Supabase signed URL and return a Buffer. */
async function downloadFromStorage(signedUrl: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(signedUrl);
    if (!resp.ok) {
      console.error(`[DriveExporter] Storage download HTTP ${resp.status} for ${signedUrl.substring(0, 80)}`);
      return null;
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (e: any) {
    console.error('[DriveExporter] downloadFromStorage error:', e.message);
    return null;
  }
}

/** Return a fresh signed URL for a storage path (valid 1 hour). */
async function getFreshSignedUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('attachments')
    .createSignedUrl(storagePath, 3600);
  if (error) {
    console.error('[DriveExporter] createSignedUrl error:', error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/** Extract the storage path from a signed URL (everything after /object/sign/attachments/). */
function storagePathFromSignedUrl(signedUrl: string): string | null {
  const m = signedUrl.match(/\/object\/sign\/attachments\/(.+?)(?:\?|$)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Check that a Drive folder still exists. Returns false on 404 or error. */
async function driveItemExists(drive: any, fileId: string): Promise<boolean> {
  try {
    await drive.files.get({ fileId, fields: 'id', supportsAllDrives: false });
    return true;
  } catch (e: any) {
    if (e?.code === 404 || e?.status === 404) return false;
    console.error(`[DriveExporter] driveItemExists(${fileId}) error:`, e.message);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class DriveExporter {
  private drive: any;
  private userId: string;

  constructor(refreshToken: string, userId: string) {
    this.userId = userId;
    const auth = makeOAuth2Client(refreshToken);
    this.drive = google.drive({ version: 'v3', auth });
  }

  /**
   * Ensure a root "Donna" folder exists in the user's Drive.
   * Stores the folder ID in configurations.drive_root_folder_id.
   * Returns the folder ID (creates if needed).
   */
  async ensureRootFolder(): Promise<string | null> {
    try {
      // Check cached value in configurations
      const { data: cfg } = await supabase
        .from('configurations')
        .select('drive_root_folder_id')
        .eq('user_id', this.userId)
        .single();

      const cachedId: string | null = cfg?.drive_root_folder_id ?? null;

      if (cachedId) {
        const exists = await driveItemExists(this.drive, cachedId);
        if (exists) {
          console.log(`[DriveExporter] Root folder exists: ${cachedId}`);
          return cachedId;
        }
        console.log(`[DriveExporter] Root folder ${cachedId} gone — recreating`);
      }

      // Create "Donna" folder
      const res = await this.drive.files.create({
        requestBody: {
          name: 'Donna',
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id',
      });

      const folderId: string = res.data.id!;
      console.log(`[DriveExporter] Created root folder: ${folderId}`);

      await supabase
        .from('configurations')
        .update({ drive_root_folder_id: folderId })
        .eq('user_id', this.userId);

      return folderId;
    } catch (e: any) {
      console.error('[DriveExporter] ensureRootFolder error:', e.message);
      return null;
    }
  }

  /**
   * Ensure a subfolder "Donna/[dossierName]" exists for a dossier.
   * Stores the folder ID in dossiers.drive_folder_id.
   * Returns the folder ID.
   */
  async ensureDossierFolder(
    dossierId: string,
    dossierName: string,
    rootFolderId: string,
  ): Promise<string | null> {
    try {
      // Check cached value
      const { data: dossier } = await supabase
        .from('dossiers')
        .select('drive_folder_id')
        .eq('id', dossierId)
        .single();

      const cachedId: string | null = dossier?.drive_folder_id ?? null;

      if (cachedId) {
        const exists = await driveItemExists(this.drive, cachedId);
        if (exists) {
          console.log(`[DriveExporter] Dossier folder exists: ${cachedId}`);
          return cachedId;
        }
        console.log(`[DriveExporter] Dossier folder ${cachedId} gone — recreating`);
      }

      // Sanitize name (Drive allows most chars but trim for safety)
      const safeName = dossierName.trim().substring(0, 100) || 'Dossier';

      const res = await this.drive.files.create({
        requestBody: {
          name: safeName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [rootFolderId],
        },
        fields: 'id',
      });

      const folderId: string = res.data.id!;
      console.log(`[DriveExporter] Created dossier folder "${safeName}": ${folderId}`);

      await supabase
        .from('dossiers')
        .update({ drive_folder_id: folderId })
        .eq('id', dossierId);

      return folderId;
    } catch (e: any) {
      console.error('[DriveExporter] ensureDossierFolder error:', e.message);
      return null;
    }
  }

  /**
   * Upload a single attachment to Drive.
   * Skips if drive_file_id is already set and the file still exists.
   * Stores the file ID in dossier_documents.drive_file_id.
   */
  async uploadAttachment(
    attachment: AttachmentRow,
    dossierFolderId: string,
  ): Promise<string | null> {
    try {
      // Check if already uploaded
      if (attachment.drive_file_id) {
        const exists = await driveItemExists(this.drive, attachment.drive_file_id);
        if (exists) {
          console.log(`[DriveExporter] Attachment already uploaded: ${attachment.drive_file_id}`);
          return attachment.drive_file_id;
        }
        console.log(`[DriveExporter] Attachment ${attachment.drive_file_id} gone — re-uploading`);
      }

      if (!attachment.storage_url) {
        console.warn(`[DriveExporter] No storage_url for attachment ${attachment.id} — skipping`);
        return null;
      }

      // Download from Supabase Storage
      // Try to refresh the signed URL first (old ones may expire)
      let downloadUrl = attachment.storage_url;
      const storagePath = storagePathFromSignedUrl(downloadUrl);
      if (storagePath) {
        const freshUrl = await getFreshSignedUrl(storagePath);
        if (freshUrl) downloadUrl = freshUrl;
      }

      const buffer = await downloadFromStorage(downloadUrl);
      if (!buffer) {
        console.warn(`[DriveExporter] Could not download ${attachment.nom_fichier} — skipping`);
        return null;
      }

      // Detect MIME type from filename
      const lower = attachment.nom_fichier.toLowerCase();
      let mimeType = 'application/octet-stream';
      if (lower.endsWith('.pdf')) mimeType = 'application/pdf';
      else if (lower.endsWith('.docx'))
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      else if (lower.endsWith('.doc')) mimeType = 'application/msword';
      else if (lower.endsWith('.xlsx'))
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      else if (lower.endsWith('.png')) mimeType = 'image/png';
      else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mimeType = 'image/jpeg';

      // Upload to Drive
      const { Readable } = await import('stream');
      const stream = Readable.from(buffer);

      const res = await this.drive.files.create({
        requestBody: {
          name: attachment.nom_fichier,
          parents: [dossierFolderId],
        },
        media: {
          mimeType,
          body: stream,
        },
        fields: 'id',
      });

      const fileId: string = res.data.id!;
      console.log(`[DriveExporter] Uploaded "${attachment.nom_fichier}": ${fileId}`);

      await supabase
        .from('dossier_documents')
        .update({ drive_file_id: fileId })
        .eq('id', attachment.id);

      return fileId;
    } catch (e: any) {
      console.error(`[DriveExporter] uploadAttachment(${attachment.nom_fichier}) error:`, e.message);
      return null;
    }
  }

  /**
   * Export all dossiers (and their attachments) for a user to Google Drive.
   * Runs sequentially to avoid API rate limits.
   * Never throws — all errors are logged.
   */
  async exportAll(): Promise<void> {
    try {
      console.log(`[DriveExporter] Starting export for user ${this.userId.substring(0, 8)}...`);

      const rootFolderId = await this.ensureRootFolder();
      if (!rootFolderId) {
        console.error('[DriveExporter] Cannot proceed without root folder');
        return;
      }

      // Fetch dossiers with null drive_folder_id (not yet mirrored)
      const { data: dossiers, error: dErr } = await supabase
        .from('dossiers')
        .select('id, nom_client, drive_folder_id')
        .eq('user_id', this.userId)
        .eq('statut', 'actif');

      if (dErr || !dossiers) {
        console.error('[DriveExporter] fetchDossiers error:', dErr?.message);
        return;
      }

      for (const dossier of dossiers) {
        const dossierFolderId = await this.ensureDossierFolder(
          dossier.id,
          dossier.nom_client,
          rootFolderId,
        );
        if (!dossierFolderId) continue;

        // Fetch attachments for this dossier
        const { data: attachments, error: aErr } = await supabase
          .from('dossier_documents')
          .select('id, dossier_id, nom_fichier, storage_url, drive_file_id')
          .eq('dossier_id', dossier.id);

        if (aErr || !attachments) {
          console.error(`[DriveExporter] fetchAttachments(${dossier.id}) error:`, aErr?.message);
          continue;
        }

        for (const att of attachments) {
          await this.uploadAttachment(att as AttachmentRow, dossierFolderId);
        }
      }

      console.log(`[DriveExporter] Export complete for user ${this.userId.substring(0, 8)}`);
    } catch (e: any) {
      console.error('[DriveExporter] exportAll fatal error:', e.message);
    }
  }
}

// ─── Convenience function for the pipeline hook ───────────────────────────────

/**
 * Trigger Drive export for a user (fire-and-forget, wrapped in try/catch).
 * Call this after dossiers + attachments are written to DB.
 */
export async function triggerDriveExport(userId: string): Promise<void> {
  try {
    // Fetch refresh token
    const { data: cfg, error } = await supabase
      .from('configurations')
      .select('refresh_token, provider')
      .eq('user_id', userId)
      .single();

    if (error || !cfg) {
      console.log(`[DriveExporter] No config for user ${userId.substring(0, 8)} — skip`);
      return;
    }

    // Only run for Gmail users (not Outlook)
    if (cfg.provider && cfg.provider !== 'gmail') {
      console.log(`[DriveExporter] Provider=${cfg.provider} — Drive export Gmail-only, skip`);
      return;
    }

    if (!cfg.refresh_token) {
      console.log(`[DriveExporter] No refresh_token for user ${userId.substring(0, 8)} — skip`);
      return;
    }

    const exporter = new DriveExporter(cfg.refresh_token, userId);
    await exporter.exportAll();
  } catch (e: any) {
    console.error('[DriveExporter] triggerDriveExport error (non-blocking):', e.message);
  }
}
