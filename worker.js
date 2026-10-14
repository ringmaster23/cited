/**
 * worker.js — Cited Conversations Cloudflare Worker
 *
 * Implements "Markdown for Agents" for every page on citedconversations.com.
 *
 * When a request carries `Accept: text/markdown`, the Worker serves the
 * pre-generated .md file that build.js places alongside each .html file in
 * dist/.  Everything else is fetched from the ASSETS binding exactly as a
 * normal static-asset request, with `Vary: Accept` added to HTML responses
 * so caches never serve markdown to a browser.
 *
 * wrangler.toml must include:
 *   main = "worker.js"
 *   [assets]
 *   directory = "dist"
 *   binding = "ASSETS"
 *   run_worker_first = true       ← required for content negotiation
 *
 * DEPLOYMENT NOTE
 * ---------------
 * This file lives at the repo root.  It is in the EXCLUDE list in build.js
 * so it is never copied into dist/.  Wrangler reads it directly from the
 * repo root when running `wrangler deploy`.
 */

// Security headers mirrored from _headers so markdown responses carry them too.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// File extensions that are never HTML pages.
const ASSET_EXT = /\.(css|js|png|jpg|jpeg|webp|avif|gif|ico|svg|xml|txt|json|woff|woff2|ttf|otf|mp3|mp4|vtt|pdf|map)$/i;

// IndexNow key — served inline so the value is authoritative regardless of
// what the static-asset build has at this path.
const INDEXNOW_KEY      = 'c7d4e2f8a1b9c3d6e0f5a8b2c4d7e1f3';
const INDEXNOW_KEY_PATH = `/${INDEXNOW_KEY}.txt`;

export default {
  async fetch(request, env) {
    const url     = new URL(request.url);
    const accepts = request.headers.get('Accept') || '';
    const isPagePath = !ASSET_EXT.test(url.pathname);

    // ── IndexNow key file ────────────────────────────────────────────────────
    // Served directly from worker code so the response is authoritative and
    // independent of what the static-asset build placed at this path.
    if (url.pathname === INDEXNOW_KEY_PATH) {
      return new Response(INDEXNOW_KEY, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }

    // ── Markdown branch ──────────────────────────────────────────────────────
    if (isPagePath && accepts.includes('text/markdown')) {
      let mdPath = url.pathname;
      if (mdPath.endsWith('/')) {
        mdPath += 'index.md';
      } else if (!mdPath.includes('.')) {
        mdPath += '/index.md';
      }

      const mdUrl = new URL(request.url);
      mdUrl.pathname = mdPath;
      mdUrl.search = '';

      try {
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
      } catch (_) {}
    }

    // ── Normal / fallback branch ─────────────────────────────────────────────
    const response = await env.ASSETS.fetch(request);
    const ct = response.headers.get('Content-Type') || '';

    if (ct.includes('text/html')) {
      const headers = new Headers(response.headers);
      const existingVary = headers.get('Vary');
      headers.set('Vary', existingVary ? `${existingVary}, Accept` : 'Accept');
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
