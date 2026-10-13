/**
 * functions/_middleware.js — Cited Conversations
 *
 * Implements "Markdown for Agents" for every page.
 *
 * This is the Cloudflare Pages Functions implementation. The same logic lives
 * in worker.js for the Workers + Static Assets deployment model. Whichever
 * deployment mode is active, one of the two will intercept requests.
 *
 * When a request carries `Accept: text/markdown` the middleware tries to
 * fetch the pre-generated .md file that build.js places alongside each .html
 * in dist/ and returns it with the Cloudflare Markdown-for-Agents convention:
 *
 *   Content-Type  : text/markdown; charset=utf-8
 *   Vary          : Accept
 *   Content-Signal: ai-train=yes, search=yes, ai-input=yes
 *
 * All other requests fall through to the static assets unchanged, but HTML
 * responses get `Vary: Accept` added so CDN / proxy caches never serve a
 * cached HTML page to an agent requesting markdown.
 *
 * SECURITY NOTE
 * Markdown responses carry the same security headers that _headers applies to
 * HTML responses (minus Content-Security-Policy, which is irrelevant for a
 * markdown payload that contains no runnable content).
 */

'use strict';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// File extensions that are never HTML pages — skip markdown logic for these.
const ASSET_EXT = /\.(css|js|png|jpg|jpeg|webp|avif|gif|ico|svg|xml|txt|json|woff|woff2|ttf|otf|mp3|mp4|vtt|pdf|map)$/i;

export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);
  const accepts = request.headers.get('Accept') || '';
  const isPagePath = !ASSET_EXT.test(url.pathname);

  // ── Markdown branch ──────────────────────────────────────────────────────
  if (isPagePath && accepts.includes('text/markdown') && env.ASSETS) {
    let mdPath = url.pathname;
    if (mdPath.endsWith('/')) {
      mdPath += 'index.md';
    } else if (!mdPath.includes('.')) {
      mdPath += '/index.md';
    }

    const mdUrl = new URL(request.url);
    mdUrl.pathname = mdPath;
    mdUrl.search = '';

    const mdResponse = await env.ASSETS.fetch(
      new Request(mdUrl.toString(), { method: 'GET' })
    );

    if (mdResponse.ok) {
      const headers = new Headers(SECURITY_HEADERS);
      headers.set('Content-Type', 'text/markdown; charset=utf-8');
      headers.set('Vary', 'Accept');
      headers.set('Content-Signal', 'ai-train=yes, search=yes, ai-input=yes');

      const cc = mdResponse.headers.get('Cache-Control');
      if (cc) headers.set('Cache-Control', cc);

      return new Response(mdResponse.body, { status: 200, headers });
    }
    // No .md found — fall through to serve the HTML version.
  }

  // ── Normal / fallback branch ─────────────────────────────────────────────
  const response = await next();
  const ct = response.headers.get('Content-Type') || '';

  if (ct.includes('text/html')) {
    const headers = new Headers(response.headers);
    const existingVary = headers.get('Vary');
    headers.set('Vary', existingVary ? `${existingVary}, Accept` : 'Accept');
    // Advertise the markdown alternate to agents that discover it via Link header.
    headers.set(
      'Link',
      `<${url.pathname}>; rel="alternate"; type="text/markdown"`
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}
