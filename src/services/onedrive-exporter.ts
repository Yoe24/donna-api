/**
 * OneDriveExporter — mirrors Donna's dossiers and attachments into Microsoft OneDrive.
 *
 * Modelled on DriveExporter (Google Drive) — same idempotency guarantees,
 * same fire-and-forget pattern, same error handling.
 *
 * Scope used: Files.ReadWrite (delegated).
 * Token obtained via MSAL refresh flow from configurations.outlook_refresh_token.
 *
 * Graph endpoints:
 *   Create folder : POST /me/drive/root/children
 *   Upload file   : PUT  /me/drive/items/{parentId}:/{filename}:/content
 *   Get folder id : GET  /me/drive/items/{id}
 */

import { ConfidentialClientApplication, Configuration, RefreshTokenRequest } from '@azure/msal-node';
import { supabase } from '../config/supabase';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AttachmentRow {
  id: string;
  dossier_id: string;
  nom_fichier: string;
  storage_url: string | null;
  onedrive_file_id: string | null;
}

// ─── MSAL helpers ─────────────────────────────────────────────────────────────

function buildMsalApp(): ConfidentialClientApplication {
  const msalConfig: Configuration = {
    auth: {
      clientId: process.env.AZURE_CLIENT_ID!,
      clientSecret: process.env.AZURE_CLIENT_SECRET!,
      authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    },
  };
  return new ConfidentialClientApplication(msalConfig);
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const app = buildMsalApp();
  const request: RefreshTokenRequest = {
    refreshToken,
    scopes: ['https://graph.microsoft.com/Files.ReadWrite', 'offline_access'],
  };
  const result = await app.acquireTokenByRefreshToken(request);
  if (!result?.accessToken) {
    throw new Error('MSAL: no access token returned for OneDrive');
  }
  return result.accessToken;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

async function getFreshSignedUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('attachments')
    .createSignedUrl(storagePath, 3600);
  if (error) {
    console.error('[OneDriveExporter] createSignedUrl error:', error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

function storagePathFromSignedUrl(signedUrl: string): string | null {
  const m = signedUrl.match(/\/object\/sign\/attachments\/(.+?)(?:\?|$)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function downloadFromStorage(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[OneDriveExporter] Storage download HTTP ${resp.status}`);
      return null;
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (e: any) {
    console.error('[OneDriveExporter] downloadFromStorage error:', e.message);
    return null;
  }
}

// ─── Graph API helpers ────────────────────────────────────────────────────────

async function graphRequest(
  accessToken: string,
  method: string,
  path: string,
  body?: any,
  contentType = 'application/json',
): Promise<any> {
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': contentType,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph ${method} ${path} → ${res.status}: ${text.substring(0, 300)}`);
  }

  if (res.status === 204) return {};
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return {};
}

async function oneDriveItemExists(accessToken: string, itemId: string): Promise<boolean> {
  try {
    const r = await graphRequest(accessToken, 'GET', `/me/drive/items/${itemId}?$select=id`);
    return r !== null && !!r.id;
  } catch {
    return false;
  }
}

// ─── Public class ─────────────────────────────────────────────────────────────

export class OneDriveExporter {
  private readonly userId: string;
  private readonly refreshToken: string;
  private accessToken: string | null = null;

  constructor(refreshToken: string, userId: string) {
    this.refreshToken = refreshToken;
    this.userId = userId;
  }

  private async token(): Promise<string> {
    if (!this.accessToken) {
      this.accessToken = await getAccessToken(this.refreshToken);
    }
    return this.accessToken;
  }

  /**
   * Ensure "Donna" root folder exists in OneDrive.
   * Stores folder ID in configurations.onedrive_root_folder_id.
   */
  async ensureRootFolder(): Promise<string | null> {
    try {
      const { data: cfg } = await supabase
        .from('configurations')
        .select('onedrive_root_folder_id')
        .eq('user_id', this.userId)
        .single();

      const cachedId: string | null = cfg?.onedrive_root_folder_id ?? null;

      if (cachedId) {
        const tok = await this.token();
        const exists = await oneDriveItemExists(tok, cachedId);
        if (exists) {
          console.log(`[OneDriveExporter] Root folder exists: ${cachedId}`);
          return cachedId;
        }
        console.log(`[OneDriveExporter] Root folder ${cachedId} gone — recreating`);
      }

      const tok = await this.token();
      const res = await graphRequest(tok, 'POST', '/me/drive/root/children', {
        name: 'Donna',
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      });

      const folderId: string = res?.id;
      if (!folderId) throw new Error('No id returned for root folder');

      console.log(`[OneDriveExporter] Created root folder: ${folderId}`);

      await supabase
        .from('configurations')
        .update({ onedrive_root_folder_id: folderId })
        .eq('user_id', this.userId);

      return folderId;
    } catch (e: any) {
      console.error('[OneDriveExporter] ensureRootFolder error:', e.message);
      return null;
    }
  }

  /**
   * Ensure Donna/[dossierName] subfolder exists in OneDrive.
   * Stores folder ID in dossiers.onedrive_folder_id.
   */
  async ensureDossierFolder(
    dossierId: string,
    dossierName: string,
    rootFolderId: string,
  ): Promise<string | null> {
    try {
      const { data: dossier } = await supabase
        .from('dossiers')
        .select('onedrive_folder_id')
        .eq('id', dossierId)
        .single();

      const cachedId: string | null = dossier?.onedrive_folder_id ?? null;

      if (cachedId) {
        const tok = await this.token();
        const exists = await oneDriveItemExists(tok, cachedId);
        if (exists) {
          console.log(`[OneDriveExporter] Dossier folder exists: ${cachedId}`);
          return cachedId;
        }
        console.log(`[OneDriveExporter] Dossier folder ${cachedId} gone — recreating`);
      }

      const safeName = dossierName.trim().substring(0, 100) || 'Dossier';
      const tok = await this.token();
      const res = await graphRequest(tok, 'POST', `/me/drive/items/${rootFolderId}/children`, {
        name: safeName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      });

      const folderId: string = res?.id;
      if (!folderId) throw new Error(`No id returned for dossier folder "${safeName}"`);

      console.log(`[OneDriveExporter] Created dossier folder "${safeName}": ${folderId}`);

      await supabase
        .from('dossiers')
        .update({ onedrive_folder_id: folderId })
        .eq('id', dossierId);

      return folderId;
    } catch (e: any) {
      console.error('[OneDriveExporter] ensureDossierFolder error:', e.message);
      return null;
    }
  }

  /**
   * Upload a single attachment to OneDrive.
   * Uses simple PUT for files under 4MB (typical legal attachments).
   * Skips if onedrive_file_id is already set and item still exists.
   * Stores file ID in dossier_documents.onedrive_file_id.
   */
  async uploadAttachment(
    attachment: AttachmentRow,
    dossierFolderId: string,
  ): Promise<string | null> {
    try {
      if (attachment.onedrive_file_id) {
        const tok = await this.token();
        const exists = await oneDriveItemExists(tok, attachment.onedrive_file_id);
        if (exists) {
          console.log(`[OneDriveExporter] Attachment already uploaded: ${attachment.onedrive_file_id}`);
          return attachment.onedrive_file_id;
        }
        console.log(`[OneDriveExporter] Attachment ${attachment.onedrive_file_id} gone — re-uploading`);
      }

      if (!attachment.storage_url) {
        console.warn(`[OneDriveExporter] No storage_url for attachment ${attachment.id} — skipping`);
        return null;
      }

      // Refresh signed URL
      let downloadUrl = attachment.storage_url;
      const storagePath = storagePathFromSignedUrl(downloadUrl);
      if (storagePath) {
        const freshUrl = await getFreshSignedUrl(storagePath);
        if (freshUrl) downloadUrl = freshUrl;
      }

      const buffer = await downloadFromStorage(downloadUrl);
      if (!buffer) {
        console.warn(`[OneDriveExporter] Could not download ${attachment.nom_fichier} — skipping`);
        return null;
      }

      // Detect MIME type
      const lower = attachment.nom_fichier.toLowerCase();
      let mimeType = 'application/octet-stream';
      if (lower.endsWith('.pdf')) mimeType = 'application/pdf';
      else if (lower.endsWith('.docx')) mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      else if (lower.endsWith('.doc')) mimeType = 'application/msword';
      else if (lower.endsWith('.xlsx')) mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      else if (lower.endsWith('.png')) mimeType = 'image/png';
      else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mimeType = 'image/jpeg';

      // PUT to OneDrive (simple upload, works for files up to 4MB)
      const safeName = encodeURIComponent(attachment.nom_fichier);
      const tok = await this.token();
      const res = await graphRequest(
        tok,
        'PUT',
        `/me/drive/items/${dossierFolderId}:/${safeName}:/content`,
        buffer,
        mimeType,
      );

      const fileId: string = res?.id;
      if (!fileId) throw new Error(`No id returned uploading "${attachment.nom_fichier}"`);

      console.log(`[OneDriveExporter] Uploaded "${attachment.nom_fichier}": ${fileId}`);

      await supabase
        .from('dossier_documents')
        .update({ onedrive_file_id: fileId })
        .eq('id', attachment.id);

      return fileId;
    } catch (e: any) {
      console.error(`[OneDriveExporter] uploadAttachment(${attachment.nom_fichier}) error:`, e.message);
      return null;
    }
  }

  /**
   * Export all active dossiers (and their attachments) to OneDrive.
   * Runs sequentially to avoid Graph API rate limits.
   * Never throws — all errors are logged.
   */
  async exportAll(): Promise<void> {
    try {
      console.log(`[OneDriveExporter] Starting export for user ${this.userId.substring(0, 8)}...`);

      const rootFolderId = await this.ensureRootFolder();
      if (!rootFolderId) {
        console.error('[OneDriveExporter] Cannot proceed without root folder');
        return;
      }

      const { data: dossiers, error: dErr } = await supabase
        .from('dossiers')
        .select('id, nom_client, onedrive_folder_id')
        .eq('user_id', this.userId)
        .eq('statut', 'actif');

      if (dErr || !dossiers) {
        console.error('[OneDriveExporter] fetchDossiers error:', dErr?.message);
        return;
      }

      for (const dossier of dossiers) {
        const dossierFolderId = await this.ensureDossierFolder(
          dossier.id,
          dossier.nom_client,
          rootFolderId,
        );
        if (!dossierFolderId) continue;

        const { data: attachments, error: aErr } = await supabase
          .from('dossier_documents')
          .select('id, dossier_id, nom_fichier, storage_url, onedrive_file_id')
          .eq('dossier_id', dossier.id);

        if (aErr || !attachments) {
          console.error(`[OneDriveExporter] fetchAttachments(${dossier.id}) error:`, aErr?.message);
          continue;
        }

        for (const att of attachments) {
          await this.uploadAttachment(att as AttachmentRow, dossierFolderId);
        }
      }

      console.log(`[OneDriveExporter] Export complete for user ${this.userId.substring(0, 8)}`);
    } catch (e: any) {
      console.error('[OneDriveExporter] exportAll fatal error:', e.message);
    }
  }
}

// ─── Convenience trigger (fire-and-forget) ────────────────────────────────────

/**
 * Trigger OneDrive export for a user.
 * Checks onedrive_sync_enabled flag. Never throws.
 */
export async function triggerOneDriveExport(userId: string): Promise<void> {
  try {
    const { data: cfg, error } = await supabase
      .from('configurations')
      .select('outlook_refresh_token, provider, onedrive_sync_enabled')
      .eq('user_id', userId)
      .single();

    if (error || !cfg) {
      console.log(`[OneDriveExporter] No config for user ${userId.substring(0, 8)} — skip`);
      return;
    }

    if (!cfg.onedrive_sync_enabled) {
      console.log(`[OneDriveExporter] Skipped (opt-in disabled) for user ${userId.substring(0, 8)}`);
      return;
    }

    if (!cfg.outlook_refresh_token) {
      console.log(`[OneDriveExporter] No outlook_refresh_token for user ${userId.substring(0, 8)} — skip`);
      return;
    }

    const exporter = new OneDriveExporter(cfg.outlook_refresh_token, userId);
    await exporter.exportAll();
  } catch (e: any) {
    console.error('[OneDriveExporter] triggerOneDriveExport error (non-blocking):', e.message);
  }
}
