#!/usr/bin/env node
/**
 * scripts/indexnow-submit.js
 * Submits all URLs from sitemap.xml to Bing via the IndexNow API.
 *
 * Runs automatically as part of `wrangler deploy` (via wrangler.toml [build] command).
 * Safe to run standalone:  node scripts/indexnow-submit.js
 *
 * IndexNow key  : c7d4e2f8a1b9c3d6e0f5a8b2c4d7e1f3
 * Key file URL  : https://citedconversations.com/c7d4e2f8a1b9c3d6e0f5a8b2c4d7e1f3.txt
 * Endpoint      : https://www.bing.com/indexnow  (distributes to Bing / DuckDuckGo)
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
const INDEXNOW_ENDPOINT     = 'www.bing.com';
const INDEXNOW_PATH         = '/indexnow';

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
      console.warn(`[indexnow]   Expected at: ${INDEXNOW_KEY_LOCATION}`);
    } else if (result.statusCode === 429) {
      console.warn('[indexnow] ⚠ HTTP 429 — rate limited. URLs already queued.');
    } else {
      console.warn(`[indexnow] ⚠ Unexpected HTTP ${result.statusCode}`);
      if (result.body) console.warn(`[indexnow]   ${result.body.slice(0, 300)}`);
    }
  } catch (err) {
    console.warn(`[indexnow] ⚠ Network error (build continues): ${err.message}`);
  }
}

main();
