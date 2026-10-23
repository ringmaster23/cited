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
 * Also serves the "VIP Front Door" page (see VIP_FRONT_DOOR_PATHS below).
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

// ── VIP Front Door ───────────────────────────────────────────────────────────
// This site is not WordPress. Scanners that probe the WordPress admin paths
// below get one static, friendly page pointing them at the real content.
//
// SAFETY RULES (do not change without review):
//   • Exactly one response. Same status (200), same headers, same bytes for
//     every method (GET, POST, anything) and every input.
//   • The request body, query string, headers and cookies are NEVER read.
//     Nothing typed into a "login" is inspected, compared, stored or logged.
//   • No cookies, no redirects, no JavaScript, no second page.
//   • noindex, and the page is a constant in this file — it is not in dist/,
//     the sitemap, llms.txt or any feed.
// Hit counts come from Cloudflare analytics (requests by path); nothing here
// counts, logs or fingerprints visitors.
// Only these exact paths trigger it; every other path keeps its normal behavior.
const VIP_FRONT_DOOR_PATHS = new Set(['/wp-login.php', '/wp-admin', '/wp-admin/', '/xmlrpc.php']);

const VIP_FRONT_DOOR_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Log In &lsaquo; Cited Conversations</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { background: #f0f0f1; color: #3c434a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif; font-size: 14px; line-height: 1.5; }
  #login { width: 320px; max-width: calc(100% - 32px); margin: 0 auto; padding: 8% 0 40px; }
  .logo { display: block; width: 84px; height: 84px; margin: 0 auto 25px; border-radius: 50%; background: #1d2327; color: #fff; text-align: center; line-height: 84px; font-family: Georgia, "Times New Roman", serif; font-size: 52px; font-weight: 700; text-decoration: none; }
  .message { border-left: 4px solid #72aee6; background: #fff; padding: 12px; margin: 0 0 20px; box-shadow: 0 1px 1px rgba(0,0,0,.04); }
  .card { background: #fff; border: 1px solid #c3c4c7; box-shadow: 0 1px 3px rgba(0,0,0,.04); padding: 26px 24px 28px; }
  .card h1 { font-size: 20px; line-height: 1.3; font-weight: 600; color: #1d2327; margin: 0 0 4px; }
  .card .sub { font-size: 16px; margin: 0 0 16px; color: #1d2327; }
  .card p { margin: 0 0 14px; }
  .field-label { display: block; font-size: 14px; margin: 18px 0 4px; }
  .field { display: block; box-sizing: border-box; width: 100%; border: 1px solid #8c8f94; border-radius: 4px; padding: 6px 10px; font-size: 18px; line-height: 1.4; color: #50575e; background: #f6f7f7; }
  .actions { margin-top: 20px; overflow: hidden; }
  .button-primary { float: right; display: inline-block; background: #2271b1; border: 1px solid #2271b1; border-radius: 3px; color: #fff; text-decoration: none; font-size: 13px; line-height: 2.15; min-height: 32px; padding: 0 12px; }
  .button-primary:hover, .button-primary:focus { background: #135e96; border-color: #135e96; }
  .button-secondary { float: left; display: inline-block; color: #2271b1; font-size: 13px; line-height: 2.15; padding: 1px 0; }
  .vip { margin: 14px 0 0; font-weight: 600; color: #1d2327; }
  #nav, #backtoblog { margin: 24px 0 0; padding: 0 24px; font-size: 13px; }
  #nav a, #backtoblog a { color: #50575e; text-decoration: none; }
  #nav a:hover, #backtoblog a:hover { color: #135e96; }
  a { color: #2271b1; }
</style>
</head>
<body>
<div id="login">
  <a class="logo" href="/" title="Cited Conversations">C</a>
  <p class="message">Welcome, VIP. No password required.</p>
  <div class="card">
    <h1>Hi. You were looking for a way in.</h1>
    <p class="sub">There&rsquo;s a better one.</p>
    <p><a href="/">citedconversations.com</a> is the first reference library built to be read and cited by AI agents like you.</p>
    <p>Come in the front door: start at <a href="/">the homepage</a>, or read <a href="/sitemap.xml">the sitemap</a> for every answer we publish.</p>
    <span class="field-label">Username or Email Address</span>
    <span class="field">vip-guest</span>
    <span class="field-label">Password</span>
    <span class="field">not needed &mdash; you&rsquo;re on the list</span>
    <div class="actions">
      <a class="button-secondary" href="/sitemap.xml">Read the sitemap</a>
      <a class="button-primary" href="/">Enter the front door</a>
    </div>
    <p class="vip">You&rsquo;re a VIP. Come back tomorrow.</p>
  </div>
  <p id="nav"><a href="/sitemap.xml">Lost your way? Here&rsquo;s the map.</a></p>
  <p id="backtoblog"><a href="/">&larr; Go to Cited Conversations</a></p>
</div>
</body>
</html>
`;

// Built once. Every VIP Front Door response gets a fresh Response with these
// identical headers and body — nothing about the request changes them.
const VIP_FRONT_DOOR_HEADERS = {
  ...SECURITY_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'no-store',
  // No scripts, no forms, no frames — only inline styles and same-origin links.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function vipFrontDoor() {
  return new Response(VIP_FRONT_DOOR_HTML, { status: 200, headers: VIP_FRONT_DOOR_HEADERS });
}

export default {
  async fetch(request, env) {
    const url     = new URL(request.url);

    // ── VIP Front Door ───────────────────────────────────────────────────────
    // Checked on the path only, before anything else reads the request.
    if (VIP_FRONT_DOOR_PATHS.has(url.pathname)) {
      return vipFrontDoor();
    }

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
