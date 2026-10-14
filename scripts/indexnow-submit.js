#!/usr/bin/env node
/**
 * scripts/indexnow-submit.js
 * Submits all URLs from sitemap.xml to Bing via the IndexNow API.
 *
 * Runs automatically as part of `wrangler deploy` (via wrangler.toml [build] command).
 * Safe to run standalone:  node scripts/indexnow-submit.js
 *
 * IndexNow key  : b3a7c9f2e1d4a8b6c0f3e5d7a2b4c6d8
 * Key file URL  : https://citedconversations.com/b3a7c9f2e1d4a8b6c0f3e5d7a2b4c6d8.txt
 * Endpoint      : https://www.bing.com/indexnow  (distributes to Bing / DuckDuckGo)
 *
 * Docs: https://www.indexnow.org/
 *
 * FIRST-DEPLOY NOTE
 * -----------------
 * The key file must be live on the site before Bing can verify ownership.
 * Bing verifies asynchronously, so submitting before the deploy completes
 * is fine — by the time Bing crawls the key URL, the deploy is done.
 * If you see HTTP 422 in the output, the key file isn't live yet; it will
 * resolve automatically on the next deploy.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const INDEXNOW_KEY          = 'b3a7c9f2e1d4a8b6c0f3e5d7a2b4c6d8';
const INDEXNOW_HOST         = 'citedconversations.com';
const INDEXNOW_KEY_LOCATION = `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`;
const INDEXNOW_ENDPOINT     = 'www.bing.com';
const INDEXNOW_PATH         = '/indexnow';

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractUrls(xml) {
  const urls = [];
  const re   = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }
  return urls;
}

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request(
      {
        hostname : INDEXNOW_ENDPOINT,
        path     : INDEXNOW_PATH,
        method   : 'POST',
        headers  : {
          'Content-Type'   : 'application/json; charset=utf-8',
          'Content-Length' : Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end',  () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Read sitemap from repo root (one level up from scripts/)
  const sitemapPath = path.resolve(__dirname, '..', 'sitemap.xml');

  if (!fs.existsSync(sitemapPath)) {
    console.warn('[indexnow] sitemap.xml not found at', sitemapPath, '— skipping submission.');
    return;
  }

  const xml  = fs.readFileSync(sitemapPath, 'utf8');
  const urls = extractUrls(xml);

  if (!urls.length) {
    console.warn('[indexnow] No <loc> URLs found in sitemap.xml — skipping.');
    return;
  }

  console.log(`[indexnow] Submitting ${urls.length} URLs to Bing IndexNow…`);
  urls.forEach((u) => console.log(`  ${u}`));

  const payload = {
    host        : INDEXNOW_HOST,
    key         : INDEXNOW_KEY,
    keyLocation : INDEXNOW_KEY_LOCATION,
    urlList     : urls,
  };

  try {
    const result = await post(payload);

    if (result.statusCode === 200 || result.statusCode === 202) {
      console.log(`[indexnow] ✓ Accepted — HTTP ${result.statusCode}`);
    } else if (result.statusCode === 422) {
      console.warn('[indexnow] ⚠ HTTP 422 — key file not yet verified.');
      console.warn('[indexnow]   This resolves automatically once the key file is live.');
      console.warn(`[indexnow]   Expected at: ${INDEXNOW_KEY_LOCATION}`);
    } else if (result.statusCode === 429) {
      console.warn('[indexnow] ⚠ HTTP 429 — rate limited. Bing already has these URLs queued.');
    } else {
      console.warn(`[indexnow] ⚠ Unexpected HTTP ${result.statusCode}`);
      if (result.body) console.warn(`[indexnow]   ${result.body.slice(0, 300)}`);
    }
  } catch (err) {
    // Never fail the build due to a network error.
    console.warn(`[indexnow] ⚠ Network error (build continues): ${err.message}`);
  }
}

main();
