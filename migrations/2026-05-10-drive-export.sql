-- Migration: 2026-05-10-drive-export.sql
-- Adds Google Drive integration columns for the drive-export-gmail feature.
-- Applied 2026-05-10 via direct PostgreSQL connection (IPv6, donna-api/scripts/migrate-drive.ts).

-- Column on dossiers: Google Drive folder ID for each dossier
ALTER TABLE public.dossiers ADD COLUMN IF NOT EXISTS drive_folder_id TEXT NULL;

-- Column on dossier_documents: Google Drive file ID for each attachment
ALTER TABLE public.dossier_documents ADD COLUMN IF NOT EXISTS drive_file_id TEXT NULL;

-- Column on configurations: Google Drive root "Donna" folder ID per user
ALTER TABLE public.configurations ADD COLUMN IF NOT EXISTS drive_root_folder_id TEXT NULL;
