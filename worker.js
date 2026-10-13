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
// _headers only decorates asset responses served by the binding; this worker's
// own responses need the headers added manually.
// Keep in sync with _headers whenever that file changes.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
};

// File extensions that are never HTML pages.
// Requests with these extensions skip all markdown logic.
const ASSET_EXT = /\.(css|js|png|jpg|jpeg|webp|avif|gif|ico|svg|xml|txt|json|woff|woff2|ttf|otf|mp3|mp4|vtt|pdf|map)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const accepts = request.headers.get('Accept') || '';
    const isPagePath = !ASSET_EXT.test(url.pathname);

    // ── Markdown branch ──────────────────────────────────────────────────────
    if (isPagePath && accepts.includes('text/markdown')) {
      // Derive the companion .md path:
      //   /                         → /index.md
      //   /answers/foo/             → /answers/foo/index.md
      //   /answers/foo              → /answers/foo/index.md
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

          // Forward cache directives from the .md asset if present.
          const cc = mdResponse.headers.get('Cache-Control');
          if (cc) headers.set('Cache-Control', cc);

          return new Response(mdResponse.body, { status: 200, headers });
        }
        // No .md found → fall through to serve the HTML version.
      } catch (_) {
        // ASSETS binding unavailable or fetch failed → serve HTML normally.
      }
    }

    // ── Normal / fallback branch ─────────────────────────────────────────────
    // All other requests (HTML, CSS, JS, images, …) come here.
    const response = await env.ASSETS.fetch(request);
    const ct = response.headers.get('Content-Type') || '';

    if (ct.includes('text/html')) {
      // Add Vary: Accept so CDN/proxy caches never serve a cached HTML page
      // to an agent requesting markdown at the same URL.
      const headers = new Headers(response.headers);
      const existingVary = headers.get('Vary');
      headers.set('Vary', existingVary ? `${existingVary}, Accept` : 'Accept');

      // Advertise the markdown alternate to agents that discover capabilities
      // via response headers (before sending Accept: text/markdown).
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
