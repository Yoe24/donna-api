-- Migration: Drive sync opt-in
-- Date: 2026-05-10
-- Applied via: psql on VPS
--
-- Adds drive_sync_enabled flag to configurations.
-- Default false = Drive export skipped for all existing users.
-- Must be explicitly set to true (via onboarding wizard or Settings).
--
-- For alexandra@demo.donna-legal.com (demo user):
-- UPDATE configurations SET drive_sync_enabled=true WHERE user_id='378cf355-8faa-4b90-add0-6dd3a6db1518';

ALTER TABLE configurations ADD COLUMN IF NOT EXISTS drive_sync_enabled BOOLEAN NOT NULL DEFAULT false;
