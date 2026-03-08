import { Pool } from 'pg';
import { Email, Draft, DailyStats } from '../types';

export class EmailModel {
  constructor(private pool: Pool) {}

  async create(email: Omit<Email, 'id' | 'created_at'>): Promise<Email> {
    const query = `
      INSERT INTO emails (from_email, to_email, subject, body, body_html, category, confidence, raw_email)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const values = [
      email.from_email,
      email.to_email,
      email.subject,
      email.body,
      email.body_html,
      email.category,
      email.confidence,
      email.raw_email,
    ];
    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  async findRecent(limit: number = 50): Promise<Email[]> {
    const query = `SELECT * FROM emails ORDER BY created_at DESC LIMIT $1`;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  async findById(id: string): Promise<Email | null> {
    const query = `SELECT * FROM emails WHERE id = $1`;
    const result = await this.pool.query(query, [id]);
    return result.rows[0] || null;
  }
}

export class DraftModel {
  constructor(private pool: Pool) {}

  async create(draft: Omit<Draft, 'id' | 'created_at' | 'updated_at'>): Promise<Draft> {
    const query = `
      INSERT INTO drafts (email_id, to_email, subject, body, annotations, status)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [
      draft.email_id,
      draft.to_email,
      draft.subject,
      draft.body,
      JSON.stringify(draft.annotations),
      draft.status,
    ];
    const result = await this.pool.query(query, values);
    return result.rows[0];
  }

  async findRecent(limit: number = 50): Promise<Draft[]> {
    const query = `
      SELECT d.*, e.from_email as email_from, e.subject as email_subject
      FROM drafts d
      JOIN emails e ON d.email_id = e.id
      ORDER BY d.created_at DESC
      LIMIT $1
    `;
    const result = await this.pool.query(query, [limit]);
    return result.rows;
  }

  async validate(id: string): Promise<Draft | null> {
    const query = `
      UPDATE drafts SET status = 'validated', updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.pool.query(query, [id]);
    return result.rows[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const query = `DELETE FROM drafts WHERE id = $1`;
    const result = await this.pool.query(query, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async findById(id: string): Promise<Draft | null> {
    const query = `SELECT * FROM drafts WHERE id = $1`;
    const result = await this.pool.query(query, [id]);
    return result.rows[0] || null;
  }
}

export class StatsModel {
  constructor(private pool: Pool) {}

  async getToday(): Promise<DailyStats> {
    const query = `
      INSERT INTO daily_stats (date) VALUES (CURRENT_DATE)
      ON CONFLICT (date) DO NOTHING
    `;
    await this.pool.query(query);
    
    const result = await this.pool.query(
      'SELECT * FROM daily_stats WHERE date = CURRENT_DATE'
    );
    return result.rows[0];
  }

  async incrementEmails(): Promise<void> {
    await this.pool.query(`
      INSERT INTO daily_stats (date, emails_received)
      VALUES (CURRENT_DATE, 1)
      ON CONFLICT (date) DO UPDATE SET emails_received = daily_stats.emails_received + 1
    `);
  }

  async incrementDrafts(): Promise<void> {
    await this.pool.query(`
      INSERT INTO daily_stats (date, drafts_created)
      VALUES (CURRENT_DATE, 1)
      ON CONFLICT (date) DO UPDATE SET drafts_created = daily_stats.drafts_created + 1
    `);
  }

  async incrementValidated(): Promise<void> {
    await this.pool.query(`
      INSERT INTO daily_stats (date, drafts_validated, time_saved_minutes)
      VALUES (CURRENT_DATE, 1, 5)
      ON CONFLICT (date) DO UPDATE SET 
        drafts_validated = daily_stats.drafts_validated + 1,
        time_saved_minutes = daily_stats.time_saved_minutes + 5
    `);
  }

  async getCurrentStats(): Promise<DailyStats> {
    const result = await this.pool.query(`
      SELECT 
        COALESCE(SUM(emails_received), 0) as emails_received,
        COALESCE(SUM(drafts_created), 0) as drafts_created,
        COALESCE(SUM(drafts_validated), 0) as drafts_validated,
        COALESCE(SUM(time_saved_minutes), 0) as time_saved_minutes
      FROM daily_stats
      WHERE date = CURRENT_DATE
    `);
    
    const row = result.rows[0];
    return {
      date: new Date().toISOString().split('T')[0],
      emails_received: parseInt(row.emails_received),
      drafts_created: parseInt(row.drafts_created),
      drafts_validated: parseInt(row.drafts_validated),
      time_saved_minutes: parseInt(row.time_saved_minutes),
    };
  }
}
