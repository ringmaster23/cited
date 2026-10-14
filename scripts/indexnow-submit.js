#!/usr/bin/env node
/**
 * scripts/indexnow-submit.js
 * Submits all URLs from sitemap.xml to every IndexNow-compatible engine
 * that has accepted submissions from citedconversations.com.
 *
 * Runs automatically as part of `wrangler deploy` (via wrangler.toml [build] command).
 * Safe to run standalone:  node scripts/indexnow-submit.js
 *
 * IndexNow key       : c7d4e2f8a1b9c3d6e0f5a8b2c4d7e1f3
 * Key file URL       : https://citedconversations.com/c7d4e2f8a1b9c3d6e0f5a8b2c4d7e1f3.txt
 *
 * Engines targeted (all returned 200/202 on 2026-10-14):
 *   Bing       https://www.bing.com/indexnow          (also powers DuckDuckGo)
 *   Seznam     https://search.seznam.cz/indexnow
 *   Naver      https://searchadvisor.naver.com/indexnow
 *   Yep        https://indexnow.yep.com/indexnow
 *
 * Engines skipped:
 *   api.indexnow.org — consistent 403 from consortium endpoint; direct engine
 *                      submissions above cover all members that actually respond.
 *   Yandex           — endpoint drops the connection (socket hang up) from
 *                      automated environments; submit manually if needed.
 *
 * Docs: https://www.indexnow.org/
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const INDEXNOW_KEY          = 'c7d4e2f8a1b9c3d6e0f5a8b2c4d7e1f3';
const INDEXNOW_HOST         = 'citedconversations.com';
const INDEXNOW_KEY_LOCATION = `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`;

// Engines that reliably accept submissions (HTTP 200 or 202).
const ENGINES = [
  { name: 'Bing',   hostname: 'www.bing.com',                   path: '/indexnow' },
  { name: 'Seznam', hostname: 'search.seznam.cz',               path: '/indexnow' },
  { name: 'Naver',  hostname: 'searchadvisor.naver.com',        path: '/indexnow' },
  { name: 'Yep',    hostname: 'indexnow.yep.com',               path: '/indexnow' },
];

function extractUrls(xml) {
  const urls = [];
  const re   = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }
  return urls;
}

function post(hostname, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request(
      {
        hostname,
        path     : urlPath,
        method   : 'POST',
        headers  : {
          'Content-Type'   : 'application/json; charset=utf-8',
          'Content-Length' : Buffer.byteLength(body),
        },
        timeout  : 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end',  () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const sitemapPath = path.resolve(__dirname, '..', 'sitemap.xml');

  if (!fs.existsSync(sitemapPath)) {
    console.warn('[indexnow] sitemap.xml not found — skipping submission.');
    return;
  }

  const xml  = fs.readFileSync(sitemapPath, 'utf8');
  const urls = extractUrls(xml);

  if (!urls.length) {
    console.warn('[indexnow] No <loc> URLs found in sitemap.xml — skipping.');
    return;
  }

  console.log(`[indexnow] Submitting ${urls.length} URLs to ${ENGINES.length} engines…`);
  urls.forEach((u) => console.log(`  ${u}`));

  const payload = {
    host        : INDEXNOW_HOST,
    key         : INDEXNOW_KEY,
    keyLocation : INDEXNOW_KEY_LOCATION,
    urlList     : urls,
  };

  for (const engine of ENGINES) {
    try {
      const result = await post(engine.hostname, engine.path, payload);

      if (result.statusCode === 200 || result.statusCode === 202) {
        console.log(`[indexnow] ✓ ${engine.name} — HTTP ${result.statusCode} Accepted`);
      } else if (result.statusCode === 422) {
        console.warn(`[indexnow] ⚠ ${engine.name} — HTTP 422 key file not yet verified.`);
        console.warn(`[indexnow]   Expected at: ${INDEXNOW_KEY_LOCATION}`);
      } else if (result.statusCode === 429) {
        console.warn(`[indexnow] ⚠ ${engine.name} — HTTP 429 rate limited. URLs already queued.`);
      } else {
        console.warn(`[indexnow] ⚠ ${engine.name} — Unexpected HTTP ${result.statusCode}`);
        if (result.body) console.warn(`[indexnow]   ${result.body.slice(0, 300)}`);
      }
    } catch (err) {
      console.warn(`[indexnow] ⚠ ${engine.name} — Network error (build continues): ${err.message}`);
    }
  }
}

main();
