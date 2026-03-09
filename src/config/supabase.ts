import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://lhtymbwluznknpatdkmo.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxodHltYndsdXpua25wYXRka21vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzAwNzIwMiwiZXhwIjoyMDg4NTgzMjAyfQ.4tDmlLMyD5AjaVnCke-OBFl6cemaB1jzRK4-SD9uoko';

export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Test connection
export async function testSupabaseConnection() {
  const { data, error } = await supabase.from('emails').select('count').limit(1);
  if (error) {
    console.error('❌ Supabase connection error:', error.message);
    return false;
  }
  console.log('✅ Supabase connected');
  return true;
}
