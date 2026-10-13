#!/usr/bin/env node
/**
 * scripts/check-live-site.js
 *
 * Checks every URL in the sitemap for broken structure, and compares the live
 * site's committed build marker against the latest commit on main.
 *
 * Usage:
 *   node scripts/check-live-site.js
 *   node scripts/check-live-site.js --json      (machine-readable output)
 *   node scripts/check-live-site.js --slack-url https://hooks.slack.com/...
 *
 * Exit 0 = all clear. Exit 1 = one or more issues.
 *
 * Used by the nightly-build-shift Slack alert: if any page fails, the script
 * exits 1 and prints a Slack-ready summary that the process can forward as a DM.
 */

'use strict';

const https    = require('https');
const http     = require('http');
const url_mod  = require('url');
const path     = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const SITE      = 'https://citedconversations.com';
const SITEMAP   = SITE + '/sitemap.xml';
const GITHUB_API = 'https://api.github.com/repos/ringmaster23/cited/commits/main';

// Extra non-HTML URLs to check for 200 + content
const EXTRA_URLS = [
  SITE + '/feed.xml',
  SITE + '/llms.txt',
  SITE + '/llms-full.txt',
  SITE + '/robots.txt',
];

// Known mojibake patterns (Latin-1 decoded UTF-8 sequences)
const MOJIBAKE_RE = /\u00e2\u0080[\u0080-\u00bf]/u;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetch(urlStr, opts) {
  return new Promise(function(resolve, reject) {
    opts = opts || {};
    var parsed  = url_mod.parse(urlStr);
    var useHttps = parsed.protocol === 'https:';
    var mod = useHttps ? https : http;
    var req = mod.get({
      hostname: parsed.hostname,
      path: parsed.path,
      headers: { 'User-Agent': 'cited-health-check/1.0' }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('timeout')); });
  });
}

function parseSitemapUrls(xml) {
  var urls = [];
  var re = /<loc>([^<]+)<\/loc>/g;
  var m;
  while ((m = re.exec(xml)) !== null) urls.push(m[1].trim());
  return urls;
}

function checkHtml(url, body) {
  var errs = [];
  var scriptOpens  = (body.match(/<script[\s>]/gi) || []).length;
  var scriptCloses = (body.match(/<\/script>/gi) || []).length;
  if (scriptOpens !== scriptCloses) errs.push('unclosed <script> (' + scriptOpens + '↑/' + scriptCloses + '↓)');
  if (!body.includes('</head>')) errs.push('missing </head>');
  if (!/<body[\s>]/i.test(body)) errs.push('missing <body>');
  if (!body.includes('</body>')) errs.push('missing </body>');

  // JSON-LD validity
  var ldMatch = body.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ldMatch) {
    try { JSON.parse(ldMatch[1]); }
    catch (e) { errs.push('invalid JSON-LD: ' + e.message.split('\n')[0].substring(0, 60)); }
  }

  // Mojibake: check for Latin-1 decoded UTF-8 sequences (â€" etc.)
  // These show as sequences like \xE2\x80\x94 in the UTF-8 text
  var mojibakeCount = 0;
  for (var i = 0; i < body.length - 2; i++) {
    var c1 = body.charCodeAt(i);
    var c2 = body.charCodeAt(i+1);
    var c3 = body.charCodeAt(i+2);
    if (c1 === 0xE2 && c2 === 0x80 && c3 >= 0x80 && c3 <= 0xBF) mojibakeCount++;
  }
  if (mojibakeCount > 0) errs.push('mojibake: ' + mojibakeCount + ' â€"-style sequences found');

  // Extract build commit marker
  var commitMatch = body.match(/<meta name="build-commit" content="([^"]{7,})"/);
  var buildCommit = commitMatch ? commitMatch[1] : null;

  return { errs: errs, buildCommit: buildCommit };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  var args = process.argv.slice(2);
  var jsonMode = args.includes('--json');
  var slackUrl = null;
  var slackIdx = args.indexOf('--slack-url');
  if (slackIdx >= 0) slackUrl = args[slackIdx + 1];

  console.log('Fetching sitemap...');
  var sitemapRes = await fetch(SITEMAP);
  if (sitemapRes.status !== 200) {
    console.error('ERROR: sitemap returned HTTP ' + sitemapRes.status);
    process.exit(1);
  }
  var htmlUrls = parseSitemapUrls(sitemapRes.body);
  if (!htmlUrls.length) {
    console.error('ERROR: no URLs found in sitemap');
    process.exit(1);
  }

  // Get latest commit on main
  var latestCommit = null;
  try {
    var ghRes = await fetch(GITHUB_API);
    var ghData = JSON.parse(ghRes.body);
    latestCommit = ghData.sha ? ghData.sha.substring(0, 7) : null;
  } catch (e) {
    console.warn('Warning: could not fetch latest commit from GitHub: ' + e.message);
  }

  var results = [];
  var failCount = 0;

  // Check HTML pages from sitemap
  for (var i = 0; i < htmlUrls.length; i++) {
    var u = htmlUrls[i];
    var r = { url: u, status: null, verdict: 'pass', errors: [], buildCommit: null };
    try {
      var res = await fetch(u);
      r.status = res.status;
      if (res.status !== 200) {
        r.errors.push('HTTP ' + res.status);
        r.verdict = 'fail';
      } else {
        var check = checkHtml(u, res.body);
        r.errors = check.errs;
        r.buildCommit = check.buildCommit;
        r.verdict = check.errs.length ? 'fail' : 'pass';
      }
    } catch (e) {
      r.errors = ['fetch error: ' + e.message];
      r.verdict = 'fail';
      r.status = 0;
    }
    if (r.verdict === 'fail') failCount++;
    results.push(r);
    if (!jsonMode) {
      var line = (r.verdict === 'pass' ? 'OK   ' : 'FAIL ') + u;
      if (r.buildCommit && latestCommit && r.buildCommit !== latestCommit) {
        line += ' [STALE: live=' + r.buildCommit + ' latest=' + latestCommit + ']';
        r.errors.push('stale build: live commit ' + r.buildCommit + ' ≠ latest ' + latestCommit);
        r.verdict = 'fail';
        failCount++;
      }
      console.log(line);
      r.errors.forEach(function(e) { console.log('     • ' + e); });
    }
  }

  // Check extra text URLs
  for (var j = 0; j < EXTRA_URLS.length; j++) {
    var eu = EXTRA_URLS[j];
    var er = { url: eu, status: null, verdict: 'pass', errors: [], buildCommit: null };
    try {
      var eres = await fetch(eu);
      er.status = eres.status;
      if (eres.status !== 200) { er.errors.push('HTTP ' + eres.status); er.verdict = 'fail'; }
      else if (!eres.body || eres.body.trim().length < 10) { er.errors.push('empty response'); er.verdict = 'fail'; }
    } catch (e) {
      er.errors = ['fetch error: ' + e.message]; er.verdict = 'fail'; er.status = 0;
    }
    if (er.verdict === 'fail') failCount++;
    results.push(er);
    if (!jsonMode) {
      console.log((er.verdict === 'pass' ? 'OK   ' : 'FAIL ') + eu);
      er.errors.forEach(function(e) { console.log('     • ' + e); });
    }
  }

  var total = results.length;
  var summary = failCount === 0
    ? '✓ All ' + total + ' URLs healthy (commit: ' + (latestCommit || 'unknown') + ')'
    : '✖ ' + failCount + '/' + total + ' URLs failed — latest commit: ' + (latestCommit || 'unknown');

  console.log('\n──────────────────────────────────────────────');
  console.log(summary);

  if (jsonMode) {
    console.log(JSON.stringify({ summary: summary, failCount: failCount, total: total, latestCommit: latestCommit, results: results }, null, 2));
  }

  if (slackUrl && failCount > 0) {
    var slackMsg = { text: '*citedconversations.com health check failed*\n' + summary + '\n' +
      results.filter(function(r) { return r.verdict === 'fail'; })
        .map(function(r) { return '• ' + r.url + ': ' + r.errors.join(', '); })
        .join('\n')
    };
    try {
      var slackData = JSON.stringify(slackMsg);
      await new Promise(function(resolve, reject) {
        var sp = url_mod.parse(slackUrl);
        var req = https.request({ hostname: sp.hostname, path: sp.path, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(slackData) }
        }, function(r) { r.resume(); resolve(r.statusCode); });
        req.on('error', reject);
        req.write(slackData);
        req.end();
      });
      console.log('Slack alert sent.');
    } catch (e) {
      console.warn('Could not send Slack alert: ' + e.message);
    }
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(function(e) { console.error(e); process.exit(1); });
