/**
 * worker.js — Cited Conversations Cloudflare Worker
 *
 * Implements "Markdown for Agents" for every page on citedconversations.com.
 *
 * When a request carries `Accept: text/markdown`, the Worker serves the
 * pre-generated .md file that build.js places alongside each .html file in
 * dist/.  Everything else falls through to static assets exactly as before,
 * with `Vary: Accept` added to HTML responses so caches never serve markdown
 * to a browser.
 *
 * Response format matches the Cloudflare Markdown for Agents convention:
 *   Content-Type : text/markdown; charset=utf-8
 *   Vary         : Accept
 *   Content-Signal: ai-train=yes, search=yes, ai-input=yes
 *
 * Security headers are preserved from _headers on HTML responses (Cloudflare
 * applies them via asset binding).  The subset below is applied manually to
 * markdown responses because _headers only decorates asset responses.
 *
 * DEPLOYMENT NOTE
 * ---------------
 * This file lives at the repo root and is referenced by wrangler.toml as
 * `main = "worker.js"`.  It is added to build.js's EXCLUDE list so it is
 * never copied into dist/.
 */

'use strict';

// Security headers that appear on markdown responses.
// Keep in sync with _headers whenever that file changes.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// Extensions that identify non-HTML static assets.
// Requests with these extensions are forwarded directly without markdown logic.
const ASSET_EXT = /\.(css|js|png|jpg|jpeg|webp|avif|gif|ico|svg|xml|txt|json|woff|woff2|ttf|otf|mp3|mp4|vtt|pdf|map)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const accepts = request.headers.get('Accept') || '';
    const isPagePath = !ASSET_EXT.test(url.pathname);

    // ── Markdown branch ────────────────────────────────────────────────────
    if (isPagePath && accepts.includes('text/markdown')) {
      // Derive the .md path from the request URL.
      // /answers/foo/          → /answers/foo/index.md
      // /answers/foo           → /answers/foo/index.md
      // /                      → /index.md
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

        // Forward cache directives from the asset if present.
        const cc = mdResponse.headers.get('Cache-Control');
        if (cc) headers.set('Cache-Control', cc);

        return new Response(mdResponse.body, { status: 200, headers });
      }
      // No .md found — fall through and serve the HTML version.
    }

    // ── Normal / fallback branch ───────────────────────────────────────────
    const response = await env.ASSETS.fetch(request);
    const ct = response.headers.get('Content-Type') || '';

    if (ct.includes('text/html')) {
      // Add Vary: Accept so CDN/proxy caches never serve a cached HTML
      // response to an agent requesting markdown.
      const headers = new Headers(response.headers);
      const existingVary = headers.get('Vary');
      headers.set('Vary', existingVary ? `${existingVary}, Accept` : 'Accept');

      // Advertise the markdown alternative via Link header so agents that
      // discover capabilities from response headers can find it without
      // sending Accept: text/markdown first.
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
  },
};
