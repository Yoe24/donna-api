import pool from '../config/database';
import * as fs from 'fs';
import * as path from 'path';

async function pushSchema() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    
    console.log('🔄 Pushing schema to database...');
    await pool.query(schema);
    console.log('✅ Schema pushed successfully');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error pushing schema:', error);
    process.exit(1);
  }
}

pushSchema();
