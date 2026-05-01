// V1 Inbox to Calendar — Phase 2 — text-cleaner.ts
// Cleans HTML email body to plain text. Strips signatures, forwards, quotes.

import * as cheerio from 'cheerio';

/**
 * Convert HTML email body to clean plain text.
 * Removes: <style>, <script>, <head>, blockquotes (Re: citations),
 * Gmail quote divs, Outlook signature divs.
 * Preserves paragraph structure (\n\n between blocks).
 */
export function cleanEmailHtml(html: string): string {
  if (!html || html.trim().length === 0) return '';

  const $ = cheerio.load(html);

  // Remove tags that bring noise
  $('style, script, head, noscript').remove();

  // Remove Gmail quote blocks
  $('.gmail_quote, .gmail_extra').remove();

  // Remove Outlook signature / footer divs
  $('[class*="signature"], [id*="signature"], [class*="Signature"], [id*="Signature"]').remove();

  // Remove blockquotes (Re: citations)
  $('blockquote').remove();

  // Remove divs that are clearly forwarded/replied sections
  $('div[style*="border-left"]').remove();

  // Convert <br>, <p>, <div> to newlines to preserve structure
  $('br').replaceWith('\n');
  $('p, div, section, article, li, tr').each((_i, el) => {
    const cur = $(el);
    cur.after('\n');
  });

  // Extract text
  let text = $.root().text();

  // Normalize whitespace: collapse multiple spaces on a line but keep \n
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');

  // Collapse 3+ consecutive newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Heuristic: cut text at the first forward/reply separator.
 * Handles French and English patterns.
 */
export function cleanForwardChain(text: string): string {
  if (!text || text.trim().length === 0) return '';

  // Patterns that indicate a quoted / forwarded section starts
  const separators = [
    // English
    /^-{3,}\s*Original Message\s*-{3,}/im,
    /^From:\s+/im,
    /^On .+ wrote:/im,
    // French
    /^-{3,}\s*Message original\s*-{3,}/im,
    /^De\s*:\s+/im,
    /^Le\s+.+a\s+écrit\s*:/im,
    /^Le\s+.+a\s+écrit\s*\n/im,
    /^Envoyé\s*:\s+/im,
    /^Objet\s*:\s+/im,
    // Generic forward header block
    /^-{5,}/m,
    /^_{5,}/m,
  ];

  const lines = text.split('\n');
  let cutLine = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const sep of separators) {
      if (sep.test(line)) {
        cutLine = i;
        break;
      }
    }
    if (cutLine < lines.length) break;
  }

  const result = lines.slice(0, cutLine).join('\n');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
