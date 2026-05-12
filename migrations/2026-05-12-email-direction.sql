-- Migration: 2026-05-12-email-direction.sql
-- Adds direction column to emails table for Chantier B (import sent emails).
--
-- Values:
--   'received' = email reçu (inbox) — comportement actuel par défaut
--   'sent'     = email envoyé par l'avocat (récupéré via listSentMessages)
--
-- Backfill: tous les emails existants sont marqués 'received'. Vrai puisqu'à
-- ce jour seul le path inbox (listMessagesSince) alimente cette table.
-- listSentMessages existe côté providers mais n'est appelé nulle part en prod.
--
-- L'index partiel sur direction='sent' accélère les requêtes frontend qui
-- filtrent les "mails envoyés du dossier X" (Phase 1 brouillon-mail, qui
-- s'appuie sur le contexte des 3 derniers échanges dans les deux sens).
--
-- Applied via: psql sur VPS (donna-api-donna-api-1 → Supabase Postgres)

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS direction TEXT
    CHECK (direction IN ('received', 'sent'))
    DEFAULT 'received';

-- Ceinture-bretelle : le DEFAULT couvre les nouveaux INSERT, l'UPDATE force
-- les anciens enregistrements à 'received' si la colonne préexistait NULL.
UPDATE public.emails SET direction = 'received' WHERE direction IS NULL;

ALTER TABLE public.emails
  ALTER COLUMN direction SET NOT NULL;

-- Index partiel : économise espace disque (vs index complet) et accélère
-- les futures requêtes "mails envoyés d'un user/dossier" (rares vs received).
CREATE INDEX IF NOT EXISTS idx_emails_user_sent
  ON public.emails (user_id, created_at DESC)
  WHERE direction = 'sent';
