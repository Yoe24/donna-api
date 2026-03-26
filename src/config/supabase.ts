import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
}

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
