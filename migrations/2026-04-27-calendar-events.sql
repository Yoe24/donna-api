-- Migration: 2026-04-27-calendar-events.sql
-- Creates the donna.calendar_events table for the email→calendar feature.
-- DO NOT execute manually. Applied post-merge by Arya via service role.

CREATE SCHEMA IF NOT EXISTS donna;

CREATE TABLE IF NOT EXISTS donna.calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id uuid REFERENCES donna.dossiers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  date_start timestamptz NOT NULL,
  date_end timestamptz,
  title text NOT NULL,
  description text,
  source_type text NOT NULL CHECK (source_type IN ('email','attachment')),
  source_id uuid,
  source_filename text,
  confidence numeric DEFAULT 1.0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_events_user_date_idx
  ON donna.calendar_events (user_id, date_start);

CREATE INDEX IF NOT EXISTS calendar_events_dossier_idx
  ON donna.calendar_events (dossier_id);
