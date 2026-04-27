/**
 * src/lib/openai.ts
 *
 * Shared OpenAI client singleton.
 * Import from here instead of instantiating per-service.
 *
 * The fallback key ('test-placeholder') allows the module to be imported in
 * test environments where OPENAI_API_KEY is not set. The placeholder is never
 * used in practice because all test paths pass useLLMFallback=false.
 */
import OpenAI from 'openai';

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'test-placeholder',
});
