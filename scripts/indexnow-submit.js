#!/usr/bin/env node
/**
 * scripts/indexnow-submit.js — MANUAL USE ONLY. Not part of the build.
 *
 * Usage:  node scripts/indexnow-submit.js https://citedconversations.com/some/page/ [more URLs ...]
 *
 * Submits only the page URLs you pass, to api.indexnow.org (shared with Bing, Yandex, Seznam,
 * Naver, Yep). Run it after the change is live, for a page edited outside the publish process.
 *
 * Why it is no longer in the build (changed 2026-11-01):
 *  - The build ran before the new version was live, so engines could fetch files that did not
 *    exist yet. On 2026-10-14 Bing fetched the old key file this way, got a 404, and refused the
 *    key (403 UserForbiddedToAccessSite) until the key was rotated.
 *  - It resubmitted every URL in sitemap.xml on every build, and since sitemap.xml became a
 *    sitemap index those were child-sitemap URLs, not pages.
 *  - The cited-episode-publish process already notifies IndexNow after each publish, sending only
 *    the pages whose content changed (plus new pages), once the page is confirmed live.
 *
 * IndexNow key : e8f1a43c97b25d06f4c8a1e3b7d92c05 (keep in sync with the publish routine's INDEXNOW_KEY)
 * Key file     : https://citedconversations.com/e8f1a43c97b25d06f4c8a1e3b7d92c05.txt
 * Key rotation : deploy the new key file first, confirm it serves, then switch the key here.
 */

'use strict';

const https = require('https');

const INDEXNOW_KEY          = 'e8f1a43c97b25d06f4c8a1e3b7d92c05';
const INDEXNOW_HOST         = 'citedconversations.com';
const INDEXNOW_KEY_LOCATION = `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`;

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request(
      {
        hostname : 'api.indexnow.org',
        path     : '/indexnow',
        method   : 'POST',
        headers  : { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
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
  const urls = process.argv.slice(2).filter((u) => u.startsWith(`https://${INDEXNOW_HOST}/`));
  if (!urls.length) {
    console.log('Usage: node scripts/indexnow-submit.js https://citedconversations.com/<page>/ [...]');
    console.log('Nothing submitted. Pass the page URLs that changed, after they are live.');
    return;
  }
  const res = await post({ host: INDEXNOW_HOST, key: INDEXNOW_KEY, keyLocation: INDEXNOW_KEY_LOCATION, urlList: urls });
  console.log(`[indexnow] ${urls.length} URL(s) -> HTTP ${res.statusCode}${res.body ? ' ' + res.body.slice(0, 300) : ''}`);
}

main().catch((err) => { console.error(`[indexnow] ${err.message}`); process.exitCode = 1; });
