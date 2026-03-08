-- Ultra-simple schema for single-lawyer MVP
-- No RLS, no tenant_id, no complex isolation

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Single lawyer record
CREATE TABLE lawyer (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    style VARCHAR(50) DEFAULT 'formal', -- 'formal', 'casual', 'direct'
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Incoming emails
CREATE TABLE emails (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_email VARCHAR(255) NOT NULL,
    to_email VARCHAR(255) NOT NULL,
    subject TEXT,
    body TEXT,
    body_html TEXT,
    category VARCHAR(50), -- 'pro_action', 'pro_info', 'perso', 'spam'
    confidence FLOAT,
    raw_email TEXT, -- Original email for debugging
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- AI-generated drafts
CREATE TABLE drafts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email_id UUID REFERENCES emails(id) ON DELETE CASCADE,
    to_email VARCHAR(255) NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    annotations JSONB DEFAULT '[]', -- [{type, text, confidence, ref}]
    status VARCHAR(50) DEFAULT 'draft', -- 'draft', 'validated', 'rejected'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Daily statistics
CREATE TABLE daily_stats (
    date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
    emails_received INT DEFAULT 0,
    drafts_created INT DEFAULT 0,
    drafts_validated INT DEFAULT 0,
    time_saved_minutes INT DEFAULT 0
);

-- Indexes for common queries
CREATE INDEX idx_emails_created_at ON emails(created_at DESC);
CREATE INDEX idx_emails_category ON emails(category);
CREATE INDEX idx_drafts_status ON drafts(status);
CREATE INDEX idx_drafts_email_id ON drafts(email_id);

-- Insert default lawyer (change email before production)
INSERT INTO lawyer (email, style, name) 
VALUES ('marie@example.com', 'formal', 'Maître Demo')
ON CONFLICT DO NOTHING;
