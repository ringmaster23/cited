#!/usr/bin/env node
/**
 * build.js — Cited Conversations static build script
 *
 * Copies all site files from repo root to dist/, excluding:
 *   .git/         — never deploy the git database
 *   functions/    — Workers Functions are not static assets
 *   scripts/      — Node.js build-time scripts; not part of the public site
 *   dist/         — avoid recursive copy
 *   build tooling — package.json, package-lock.json, build.js, wrangler.toml
 *
 * Post-processing steps (applied to dist/ after copy):
 *   1. Replace all href="/about/" → href="/methodology/" across every HTML file.
 *   2. Inject live answer counts into homepage conversation rows from the
 *      actual answer pages so counts can never drift from reality.
 *   2b. Bake the data-through dates from data/bot-traffic.json into stats/index.html
 *      so readers that don't run JavaScript see the current date (never fails the build).
 *   3b. Passage gates + encoding gate (added Oct 27, 2026): timing agreement across every
 *      place a passage's time is written, times vs transcript.vtt, one label per answer,
 *      schema Quotation text == visible text, one Clip per passage, no mojibake / invalid
 *      UTF-8 in served text files. See the "Passage gates" section below.
 *      Oct 27, 2026 (rule 8): host-join and host-question gates, and the verbatim gate now sees host speech.
 *      Oct 27, 2026 (rule 8 exception, refined): crosstalk is declared per host run in the article's data-crosstalk attribute;
 *      the five-word test is gone. See the host-run notes in the Passage gates section.
 *   2b'. (Oct 28, 2026) The stats page is rendered from data/bot-traffic.json at build time, not just its dates,
 *      so readers that don't run JavaScript see the real numbers.
 *   4. Consistency gates (Oct 28, 2026): answer-count, canonical-links, schema-copy, intro-time, toc-heading,
 *      anchor-text, listing-title, llms-roles, no-js-placeholder. See the "Consistency gates" section.
 *   3. Integrity check on every answer page: fail the build if any page has
 *      a TOC anchor that has no matching body id, or if the number of rendered
 *      articles differs from the number of schema Clip nodes. A broken page
 *      should never ship. (Prevents accidental-removal incidents like q2/q3/q11.)
 *
 * Note: uses .replace() with global regex (not .replaceAll) for Node 14 compat.
 * Output: dist/  (set as assets.directory in wrangler.toml)
 *
 * On any failure the build writes dist/build-report.json — a machine-readable
 * list of every error, with page slug, Q number, question text, and a plain-
 * English description. A downstream process can read this file and post the
 * details to Slack so the right answer gets routed back for correction.
 */

// ── Step 0: Regenerate llms.txt and llms-full.txt from current answer pages ──
// This MUST run before the copy step so the fresh files land in dist/.
require('./scripts/generate-llms');

var fs   = require('fs');
var path = require('path');
var generateMarkdown = require('./scripts/generate-markdown');

var ROOT    = __dirname;
var OUT     = path.join(ROOT, 'dist');
var EXCLUDE = {
  '.git':             true,
  '.github':          true,
  'dist':             true,
  'functions':        true,
  'scripts':          true,
  'node_modules':     true,
  'build.js':         true,
  'wrangler.toml':    true,
  'package.json':     true,
  'package-lock.json':true,
  'worker.js':        true,
};

// ── Report ────────────────────────────────────────────────────────────────────
// Accumulates errors from every check. Written to dist/build-report.json before
// any process.exit(1) and again at the end of a successful build (status: passed).
// A Slack-routing process reads this file to send failures to the right person.

var REPORT = {
  timestamp: new Date().toISOString(),
  tool: 'build',
  status: 'passed',
  errors: [],
  warnings: []
};

// A warning never fails the build; it is listed in dist/build-report.json so nothing is silently skipped.
function reportWarning(check, page, qId, questionText, message) {
  REPORT.warnings.push({ check: check, page: page || null, question_id: qId || null, question_text: questionText || null, message: message });
}

function reportError(check, page, qId, questionText, message) {
  REPORT.status = 'failed';
  REPORT.errors.push({
    check:         check,
    page:          page         || null,
    question_id:   qId         || null,
    question_text: questionText || null,
    message:       message
  });
}

function writeReport() {
  if (!fs.existsSync(OUT)) {
    try { fs.mkdirSync(OUT, { recursive: true }); } catch(e) {}
  }
  var outPath = path.join(OUT, 'build-report.json');
  try {
    fs.writeFileSync(outPath, JSON.stringify(REPORT, null, 2), 'utf8');
    
// ─── llms-full.txt consistency check ─────────────────────────────────────────
// Fails the build if any answer page's blockquote text is absent from
// dist/llms-full.txt.  Catches cases where generate-llms.js ran but wrote
// wrong content, or where the file was somehow omitted from the copy step.

function checkLlmsConsistency() {
  var llmsPath = path.join(OUT, 'llms-full.txt');
  if (!fs.existsSync(llmsPath)) {
    reportError('llms-check', null, null, null,
      'dist/llms-full.txt is missing — generate-llms.js may not have run or the copy step skipped it.');
    return;
  }
  var llmsContent = fs.readFileSync(llmsPath, 'utf8');
  var answersOutDir = path.join(OUT, 'answers');
  if (!fs.existsSync(answersOutDir)) return;

  function _et(h) {
    return h
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
      .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
      .replace(/&hellip;/g, '…')
      .replace(/&#8212;/g, '—').replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘')
      .replace(/&#8220;/g, '“').replace(/&#8221;/g, '”').replace(/&#8230;/g, '…')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  var slugs = fs.readdirSync(answersOutDir).filter(function(d) {
    return fs.statSync(path.join(answersOutDir, d)).isDirectory();
  });

  for (var _si = 0; _si < slugs.length; _si++) {
    var _slug = slugs[_si];
    var _file = path.join(answersOutDir, _slug, 'index.html');
    if (!fs.existsSync(_file)) continue;
    var _html = fs.readFileSync(_file, 'utf8');
    var _qaStart = _html.indexOf('class="qa-list"');
    if (_qaStart === -1) continue;
    var _ftIdx = _html.indexOf('</footer>');
    var _qaEnd = _ftIdx > -1 ? _html.lastIndexOf('</section>', _ftIdx) + 10 : _html.length;
    var _qaSection = _html.slice(_qaStart, _qaEnd);
    var _pos = 0;
    while (_pos < _qaSection.length) {
      var _aStart = _qaSection.indexOf('<article class="qa-item"', _pos);
      if (_aStart === -1) break;
      var _aEnd = _qaSection.indexOf('</article>', _aStart) + 10;
      var _art = _qaSection.slice(_aStart, _aEnd);
      var _blkM = _art.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
      var _idM  = _art.match(/id="(q\d+)"/);
      var _h3M  = _art.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      if (_blkM) {
        var _raw = _et(_blkM[1]);
        var _fi  = _raw.indexOf(' Flag:');
        if (_fi !== -1) _raw = _raw.slice(0, _fi).trim();
        // Use first 100 non-trivial chars as the probe
        var _probe = _raw.replace(/^[…\s]+/, '').slice(0, 100).trim();
        if (_probe.length > 30 && llmsContent.indexOf(_probe) === -1) {
          var _qId  = _idM ? _idM[1] : 'q?';
          var _qTxt = _h3M ? _h3M[1].replace(/<[^>]+>/g, '').trim().slice(0, 60) : '';
          var _msg  = _slug + ' ' + _qId.toUpperCase() + ': answer text in dist/llms-full.txt does not match the answer page. ' +
            'Expected to find: "' + _probe.slice(0, 80) + '..."';
          console.error('\u2717 LLMS CHECK: ' + _msg);
          reportError('llms-check', _slug, _qId, _qTxt, _msg);
        }
      }
      _pos = _aEnd;
    }
  }
  console.log('llms-full.txt consistency check passed.');
}

checkLlmsConsistency();

if (REPORT.status === 'failed') {
      console.error('  → Full report: dist/build-report.json');
    }
  } catch(e) {
    console.error('  (Could not write build-report.json: ' + e.message + ')');
  }
}

// ── Copy ──────────────────────────────────────────────────────────────────────

function copy(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  var items = fs.readdirSync(src);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (EXCLUDE[item]) continue;
    var s = path.join(src, item);
    var d = path.join(dest, item);
    var stat = fs.statSync(s);
    if (stat.isDirectory()) {
      copy(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ── Post-process: /about/ → /methodology/ in all HTML ─────────────────────────

function patchAboutLinks(dir) {
  var items = fs.readdirSync(dir);
  for (var i = 0; i < items.length; i++) {
    var p = path.join(dir, items[i]);
    if (fs.statSync(p).isDirectory()) {
      patchAboutLinks(p);
    } else if (items[i].endsWith('.html')) {
      var original = fs.readFileSync(p, 'utf8');
      var patched  = original
        .replace(/href="\/about\/"/g, 'href="/methodology/"')
        .replace(/href="\/about"/g,   'href="/methodology/"');
      if (patched !== original) {
        fs.writeFileSync(p, patched, 'utf8');
      }
    }
  }
}

// ── Post-process: inject real answer counts into homepage ──────────────────────
// Badge format: "N answers" (total count)

function countQaItems(slug) {
  var file = path.join(OUT, 'answers', slug, 'index.html');
  if (!fs.existsSync(file)) return 0;
  var html = fs.readFileSync(file, 'utf8');
  var matches = html.match(/class="qa-item"/g);
  return matches ? matches.length : 0;
}

function patchHomepageCounts() {
  var idxPath = path.join(OUT, 'index.html');
  if (!fs.existsSync(idxPath)) return;
  var html = fs.readFileSync(idxPath, 'utf8');

  html = html.replace(
    /(<span[^>]+data-answer-slug="([^"]+)"[^>]*>)\d+ answers(<\/span>)/g,
    function(match, open, slug, close) {
      var count = countQaItems(slug);
      return open + count + ' answers' + close;
    }
  );

  fs.writeFileSync(idxPath, html, 'utf8');
}

// ── Post-process: render the stats page from real data at build time ──────────
// stats/index.html draws its numbers in the browser from data/bot-traffic.json. Most AI crawlers
// don't run JavaScript, so the build writes the same numbers (same formulas as the page script) into
// the static HTML: dates, KPI cards, the crawler table, the non-crawler table, top pages, traffic mix
// and the screen-reader summary. The browser script still runs and redraws the same values plus the
// charts. If the data can't be read the page keeps its placeholders and the no-js-placeholder gate
// fails the build, so a broken or sample page is never deployed. Demo/sample data is never used here.

var STATS_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

function statsDateShort(iso) {
  var p = iso.split('-');
  return STATS_MONTHS[parseInt(p[1], 10) - 1].slice(0, 3) + ' ' + parseInt(p[2], 10);
}

function statsDateLong(iso) {
  var p = iso.split('-');
  return STATS_MONTHS[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
}

function setElementText(html, id, inner) {
  var re = new RegExp('(<([a-z0-9]+)[^>]*\\sid="' + id + '"[^>]*>)[\\s\\S]*?(</\\2>)', 'i');
  if (!re.test(html)) return null;
  return html.replace(re, function(m, open, tag, close) { return open + inner + close; });
}

function statsEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function statsNum(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

var STATS_PALETTE = { 'GPTBot': '#A7011F', 'OAI-SearchBot': '#c8021f', 'ChatGPT-User': '#e05050', 'ClaudeBot': '#1f2937',
  'Claude-SearchBot': '#374151', 'Claude-User': '#4b5563', 'PerplexityBot': '#6b7280', 'Googlebot': '#9ca3af',
  'Google-Extended': '#d1d5db', 'Bingbot': '#6b4f2a', 'Applebot': '#4a3f35', 'Amazonbot': '#2d4a3e',
  'Meta-ExternalAgent': '#3b3060', 'Bytespider': '#5a3060', 'Grok*': '#7c3aed', 'Muse*': '#0891b2', 'Venice*': '#b45309' };
var STATS_FALLBACK = ['#A7011F', '#1f2937', '#6b7280', '#c8021f', '#374151', '#9ca3af', '#6b4f2a', '#4a3f35'];
function statsColor(name, i) { return STATS_PALETTE[name] || STATS_FALLBACK[i % STATS_FALLBACK.length]; }

function patchStatsDates() {
  try {
    var pagePath = path.join(OUT, 'stats', 'index.html');
    var dataPath = path.join(ROOT, 'data', 'bot-traffic.json');
    if (!fs.existsSync(pagePath) || !fs.existsSync(dataPath)) {
      console.warn('\u26a0\ufe0f  Stats page not rendered: stats page or data/bot-traffic.json not found.');
      return;
    }
    var data  = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    var daily = Array.isArray(data.daily) ? data.daily : [];
    var mix   = Array.isArray(data.traffic_mix) ? data.traffic_mix : [];
    var dates = [];
    daily.concat(mix).forEach(function(r) {
      if (r && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) dates.push(r.date);
    });
    dates.sort();
    var earliest = dates.length ? dates[0] : data.launch_date;
    var latest   = dates.length ? dates[dates.length - 1]
                                : (data.updated_at ? String(data.updated_at).slice(0, 10) : earliest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(earliest)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(latest))) {
      console.warn('\u26a0\ufe0f  Stats page not rendered: no usable dates in data/bot-traffic.json.');
      return;
    }
    if (daily.length === 0) {
      console.warn('\u26a0\ufe0f  Stats page not rendered: data/bot-traffic.json has no daily rows.');
      return;
    }

    // Same aggregation as the page script.
    var allDates = [];
    for (var d = new Date(earliest + 'T00:00:00Z'), end = new Date(latest + 'T00:00:00Z'); d <= end && allDates.length < 4000; d.setUTCDate(d.getUTCDate() + 1)) allDates.push(d.toISOString().slice(0, 10));
    var isSide = function(r) { return r.group === 'other' || r.group === 'malicious'; };
    var botMap = {}, pathMap = {}, byBotDate = {};
    daily.filter(function(r) { return !isSide(r); }).forEach(function(r) {
      var b = botMap[r.bot_name] || (botMap[r.bot_name] = { operator: r.operator || '\u2014', requests: 0, paths: 0 });
      b.requests += r.request_count || 0;
      b.paths += r.distinct_paths_crawled || 0;
      (r.top_paths || []).forEach(function(p) {
        var x = pathMap[p] || (pathMap[p] = { requests: 0, bots: {} });
        x.requests += r.request_count || 0;
        x.bots[r.bot_name] = 1;
      });
      var bd = byBotDate[r.bot_name] || (byBotDate[r.bot_name] = {});
      bd[r.date] = (bd[r.date] || 0) + (r.request_count || 0);
    });
    var names = Object.keys(botMap);
    var total = names.reduce(function(s, n) { return s + botMap[n].requests; }, 0);
    var active = names.filter(function(n) { return botMap[n].requests > 0; });
    var range = statsDateShort(earliest) + ' \u2013 ' + statsDateShort(latest);

    var totals = allDates.map(function(dt) { return active.reduce(function(s, n) { return s + ((byBotDate[n] || {})[dt] || 0); }, 0); });
    var peak = totals.indexOf(Math.max.apply(null, totals));

    var sorted = names.slice().sort(function(a, b) { return botMap[b].requests - botMap[a].requests || a.localeCompare(b); });
    var maxReq = sorted.length ? (botMap[sorted[0]].requests || 1) : 1;
    var botRows = sorted.map(function(n, i) {
      var b = botMap[n];
      return '\n            <tr>\n              <td class="bot-name">' + statsEsc(n) + '</td>\n              <td class="bot-op">' + statsEsc(b.operator) +
        '</td>\n              <td class="num">' + statsNum(b.requests) + '</td>\n              <td class="num">' + statsNum(b.paths) +
        '</td>\n              <td class="bar-cell"><div class="bar-fill" style="width:' + Math.max(2, Math.round((b.requests / maxReq) * 120)) + 'px;background:' + statsColor(n, i) + '"></div></td>\n            </tr>';
    }).join('') + '\n          ';

    var pages = Object.keys(pathMap).sort(function(a, b) { return pathMap[b].requests - pathMap[a].requests; }).slice(0, 20);
    var pageRows = pages.map(function(p, i) {
      return '\n            <tr>\n              <td style="color:var(--text-muted);font-variant-numeric:tabular-nums">' + (i + 1) + '</td>\n              <td class="path-cell">' + statsEsc(p) +
        '</td>\n              <td class="num">' + statsNum(pathMap[p].requests) + '</td>\n              <td class="num">' + Object.keys(pathMap[p].bots).length + '</td>\n            </tr>';
    }).join('') + '\n          ';

    var side = {};
    daily.filter(isSide).forEach(function(r) {
      var s = side[r.bot_name] || (side[r.bot_name] = { group: r.group, requests: 0 });
      s.requests += r.request_count || 0;
    });
    var unknown = Object.keys(side).filter(function(n) { return side[n].group === 'other' && side[n].requests > 0 && n === 'Other bots (unnamed)'; });
    var anyOther = Object.keys(side).some(function(n) { return side[n].group === 'other' && side[n].requests > 0; });
    var mal = Object.keys(side).filter(function(n) { return side[n].group === 'malicious'; });

    var edits = [
      ['last-updated',        'Last updated: ' + statsDateLong(latest)],
      ['stats-meta',          '<strong>' + range + '</strong><span class="sep">\u00b7</span>' +
                              'Tracking: GPTBot, ClaudeBot, PerplexityBot, Googlebot, and more'],
      ['kpi-total',           statsNum(total)],
      ['kpi-days',            statsNum(allDates.length)],
      ['kpi-bots',            statsNum(active.length)],
      ['kpi-pages',           statsNum(Object.keys(pathMap).length)],
      ['kpi-since',           range],
      ['kpi-launch-date',     range],
      ['bot-section-note',    range],
      ['chart-daily-summary', 'Peak day: ' + statsDateShort(allDates[peak]) + ' with ' + statsNum(totals[peak]) + ' requests. Total: ' + statsNum(total) + ' across ' + allDates.length + ' days.'],
      ['bot-table-body',      botRows],
      ['pages-table-body',    pageRows],
      ['other-bots-body',     unknown.length ? unknown.map(function(n) { return '<tr><td class="bot-name">' + statsEsc(n) + '</td><td class="num">' + statsNum(side[n].requests) + '</td></tr>'; }).join('') : '<tr><td colspan="2" style="color:var(--text-muted)">None yet.</td></tr>'],
      ['malicious-body',      mal.length ? mal.map(function(n) { return '<tr><td class="bot-name">' + statsEsc(n) + ' &#127988;&#8205;&#9760;&#65039;</td><td class="num">' + statsNum(side[n].requests) + '</td></tr>'; }).join('') : '<tr><td colspan="2" style="color:var(--text-muted)">None yet.</td></tr>'],
      ['updated-note',        'Data last updated: ' + statsDateLong(latest) +
                              ' \u00b7 Updates daily \u00b7 Source: Cloudflare Log Explorer']
    ];
    if (mix.length) {
      var tv = 0, ta = 0, th = 0;
      mix.forEach(function(r) { tv += r.verified_bot || 0; ta += r.automated || 0; th += r.human || 0; });
      var all = (tv + ta + th) || 1;
      edits.push(['mix-legend', [['Verified bot', tv, '#A7011F'], ['Automated', ta, '#6b7280'], ['Human', th, '#2d4a3e']].map(function(x) {
        return '\n          <div class="mix-legend-item"><div class="mix-swatch" style="background:' + x[2] + '"></div><div><strong>' + statsNum(x[1]) + '</strong> ' + x[0] + ' (' + Math.round((x[1] / all) * 100) + '%)</div></div>';
      }).join('') + '\n        ']);
    }

    var html = fs.readFileSync(pagePath, 'utf8');
    var missing = [];
    edits.forEach(function(e) {
      var next = setElementText(html, e[0], e[1]);
      if (next === null) missing.push(e[0]); else html = next;
    });
    var show = function(id) { html = html.replace(new RegExp('(id="' + id + '"[^>]*?) style="display:none"'), '$1'); };
    if (names.some(function(n) { return /\*$/.test(n); })) show('fp-key');
    if (anyOther || mal.length) show('other-bots-section');
    if (mix.length) show('mix-section');
    fs.writeFileSync(pagePath, html, 'utf8');

    if (missing.length) console.warn('\u26a0\ufe0f  Stats page: element(s) not found: ' + missing.join(', '));
    console.log('Stats page rendered from data/bot-traffic.json: ' + range + ', ' + statsNum(total) + ' requests, ' + active.length + ' crawlers (last updated ' + statsDateLong(latest) + ').');
  } catch (err) {
    console.warn('\u26a0\ufe0f  Stats page not rendered: ' + err.message);
  }
}

// ── Helpers: JSON-LD block + question text ────────────────────────────────────

function getJsonLdBlock(html) {
  var marker = '<script type="application/ld+json">';
  var start  = html.indexOf(marker);
  if (start === -1) return '';
  var end = html.indexOf('</script>', start);
  return end === -1 ? '' : html.slice(start + marker.length, end);
}

// Extract the heading text from an article block (used in error messages).
function extractQuestionText(articleHtml) {
  var hm = articleHtml.match(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/i);
  if (!hm) return null;
  return hm[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&rsquo;|&#8217;/g, '\u2019')
    .replace(/&ldquo;|&#8220;/g, '\u201C')
    .replace(/&rdquo;|&#8221;/g, '\u201D')
    .replace(/&amp;/g,   '&')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Integrity check: answer pages must be internally consistent ───────────────
// Fails the build with details if any answer page has:
//   1. A TOC anchor link (#qN) with no matching id="qN" in the body
//   2. A different number of rendered articles vs TOC anchor links
//   3. A different number of rendered articles vs JSON-LD Clip nodes
//   4. Missing required editorial fields (notice block, labels, disclosure)
//   5. Synthesis label or synthesis-sources div
//   6. Editor brackets inside any answer
//   7. Notice text that still references synthesis

function integrityCheckAnswerPages() {
  var answersDir = path.join(OUT, 'answers');
  if (!fs.existsSync(answersDir)) return;

  var errors    = [];
  var pagesFailed = 0;
  var slugs = fs.readdirSync(answersDir).filter(function(d) {
    return fs.statSync(path.join(answersDir, d)).isDirectory();
  });

  for (var si = 0; si < slugs.length; si++) {
    var slug = slugs[si];
    var file = path.join(answersDir, slug, 'index.html');
    if (!fs.existsSync(file)) continue;
    var html = fs.readFileSync(file, 'utf8');

    // Count rendered articles
    var articleCount = (html.match(/class="qa-item"/g) || []).length;

    // Collect all article ids (id="q1", id="q4", etc.)
    var articleIds  = [];
    var idPattern   = /id="(q\d+)"/g;
    var m;
    while ((m = idPattern.exec(html)) !== null) {
      articleIds.push(m[1]);
    }

    // Collect TOC anchor links (href="#q1", etc.)
    var tocAnchors  = [];
    var tocPattern  = /href="#(q\d+)"/g;
    while ((m = tocPattern.exec(html)) !== null) {
      tocAnchors.push(m[1]);
    }

    // Count Clip nodes in JSON-LD only (not body text)
    var ldBlock    = getJsonLdBlock(html);
    var clipCount  = (ldBlock.match(/"@type": "Clip"/g) || []).length;

    var pageErrors = [];

    // Check: every TOC anchor must have a matching article id
    for (var ti = 0; ti < tocAnchors.length; ti++) {
      if (articleIds.indexOf(tocAnchors[ti]) === -1) {
        var msg = 'The table of contents links to #' + tocAnchors[ti] +
                  ' but there is no article with id="' + tocAnchors[ti] + '" on the page. ' +
                  'The answer may have been removed without removing its TOC entry.';
        pageErrors.push(msg);
        reportError('integrity', slug, tocAnchors[ti], null, msg);
      }
    }

    // Check: article count must match TOC count
    if (tocAnchors.length > 0 && articleCount !== tocAnchors.length) {
      var msg = articleCount + ' answer' + (articleCount === 1 ? '' : 's') + ' rendered but ' +
                tocAnchors.length + ' TOC link' + (tocAnchors.length === 1 ? '' : 's') +
                ' — they must match. An answer may have been removed without updating the TOC.';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }

    // Check: passage count must match Clip count (one Clip per passage; an answer can show two passages)
    var passageCount = 0;
    (html.match(/<div class="qa-item__paper">[\s\S]*?<\/div>/g) || []).forEach(function(b) {
      passageCount += (b.match(/<p[\s>]/g) || []).length;
    });
    if (clipCount > 0 && passageCount !== clipCount) {
      var msg = passageCount + ' passage' + (passageCount === 1 ? '' : 's') + ' rendered but ' +
                clipCount + ' JSON-LD Clip node' + (clipCount === 1 ? '' : 's') +
                ' \u2014 they must match. The schema may be out of sync with the page content.';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }

    // Page-level editorial checks
    if (!html.includes('conversation-notice')) {
      var msg = 'Missing the top notice ("not an independent ranking") block. ' +
                'Add the .conversation-notice element.';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }
    if (!html.includes('answer-label')) {
      var msg = 'No answer has a "Verbatim" or "Edited" label. Every answer needs a label.';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }
    if (!html.includes('question headings are written by our editors')) {
      var msg = 'Missing the disclosure line "question headings are written by our editors".';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }
    if (html.match(/answer-label--synthesis/)) {
      var msg = 'A synthesis answer label was found (answer-label--synthesis). ' +
                'All answers must be Verbatim or Edited — synthesis is not allowed. ' +
                'Replace the synthesis answer with the guest\'s real transcript passage.';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }
    if (html.match(/class="synthesis-sources"/)) {
      var msg = 'A synthesis-sources div was found — remove it. ' +
                'Use the speaker\'s transcript text directly in qa-item__paper instead.';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }
    if (html.match(/labeled verbatim, edited, or synthesis/i)) {
      var msg = 'The notice text still references synthesis — change it to say "labeled verbatim or edited".';
      pageErrors.push(msg);
      reportError('integrity', slug, null, null, msg);
    }

    // Rule 6: no editor brackets inside any answer — check per article so the Q number is named.
    // Match every qa-item article to get Q id and question text alongside the paper block.
    var articleRe = /<article[^>]+class="qa-item"[^>]*>([\s\S]*?)<\/article>/g;
    while ((m = articleRe.exec(html)) !== null) {
      var artHtml  = m[1];
      var qIdMatch = artHtml.match(/id="(q\d+)"/);
      var qId      = qIdMatch ? qIdMatch[1] : null;
      var qText    = extractQuestionText(artHtml);

      var paperMatch = artHtml.match(/<div[^>]*class="qa-item__paper"[^>]*>([\s\S]*?)<\/div>/);
      if (paperMatch && /\[[^\]]+\]/.test(paperMatch[1])) {
        var qLabel = qId ? (qId.toUpperCase() + (qText ? ' \u2014 "' + qText + '"' : '')) : '(unknown Q)';
        var msg = qLabel + ': editor-added text in square brackets found inside the answer. ' +
                  'Brackets are not allowed (editorial rule 6). ' +
                  'Use the speaker\'s exact words — if a word needs context, add a separate editor\'s note outside the quote.';
        pageErrors.push(msg);
        reportError('integrity', slug, qId, qText, msg);
      }
    }

    if (pageErrors.length > 0) {
      pagesFailed++;
      errors.push('\n  Page: ' + slug);
      for (var pi = 0; pi < pageErrors.length; pi++) {
        errors.push('  \u2022 ' + pageErrors[pi]);
      }
    }
  }

  if (errors.length > 0) {
    console.error('\n\u2717 INTEGRITY CHECK \u2014 ' + pagesFailed + ' page' + (pagesFailed === 1 ? '' : 's') + ' failed:\n');
    for (var ei = 0; ei < errors.length; ei++) {
      console.error(errors[ei]);
    }
    console.error('');
    writeReport();
    process.exit(1);
  }

  console.log('Integrity check passed (' + slugs.length + ' answer page' + (slugs.length === 1 ? '' : 's') + ').');
}



// ── Passage gates ─────────────────────────────────────────────────────────────
// Added after the Oct 2026 timing / label / encoding incident (see EDITORIAL-PRINCIPLES.md
// rule 4 and 7). Every answer passage carries its time in several places. These
// gates force those places to agree with each other AND with where the words are
// really spoken in the page's own transcript.vtt, and keep labels, schema text and
// file encoding honest. Findings go to dist/build-report.json like the other gates.
//
//   passage-time    every passage has its own start–end time and its own play link
//   timing-agree    visible ▶ range, ?t= link, aria-label, data-vtt-*, schema Clip
//                   startOffset / endOffset and Clip url ?t= all say the same thing
//   timing-vtt      start/end are within PG_VTT_TOLERANCE_MS of where the first and
//                   last kept words are spoken in transcript.vtt
//   label           exactly one label per answer; "Edited" if any passage has "…",
//                   otherwise "Verbatim"
//   quotation-text  schema Quotation text equals the visible passage text exactly
//   clip-count      one Clip and one Quotation per passage
//   host-join       guest words joined across host speech with no "…" (editorial rule 8)
//   host-question   a cut over host speech needs the host's exact words shown with the answer, attributed to the
//                   host, and the "Ellipsis added" tag (rule 8).
//                   Both gates need every host run inside an answer's span to be declared: a shown host question, or
//                   crosstalk listed in the article's data-crosstalk attribute (rule 8 exception). A run containing
//                   a "?" can never be declared crosstalk. A declaration that matches no host run inside the span
//                   fails (host-crosstalk), and so does a "…" that covers nothing but declared crosstalk.
//   encoding        no mojibake and no invalid UTF-8 in any served text file
//
// Time rule: whole seconds on the page and in the schema; start rounds down, end
// rounds up from the exact millisecond cue times kept in data-vtt-start / -end.

var PG_VTT_TOLERANCE_MS = 3000;
var PG_SPEAKERS = ['Casey Cheshire', 'Adam Needles', 'Simon Wilhelm', 'Paul Jones', 'Dave Rubinstein'];
// The Descript export sometimes leaves a raw track id ("casey_3_09-24-2026_111155:") inside a cue instead of the name.
var PG_SPEAKER_ALIASES = { casey: 'Casey Cheshire', adam: 'Adam Needles', simon: 'Simon Wilhelm' };
// Longest host stretch (in words) the cut checks will look across when following a quote through the transcript.
var PG_HOST_SPAN_MAX = 1500;
// Editorial rule 8 exception (Casey, 2026-10-27): host crosstalk is ignored completely. Crosstalk is any host remark that does
// not help the answer (an acknowledgement, an agreement, an echo, a side comment), however long. The test is whether the host's
// words shape what the guest says next. Crosstalk gets no "\u2026", is not shown anywhere, has no tag, does not change the label
// and does not invalidate the answer.
//
// Code cannot judge usefulness, so a person decides and writes the decision down. Every host run inside an answer's span (a run
// is the consecutive cues of one other speaker between two of the guest's words) is either a shown host question (rule 8) or
// listed in the article's data-crosstalk attribute: the start time in milliseconds of each ignored run (its first cue, the same
// clock as data-vtt-start), separated by spaces. data-crosstalk is never rendered and is never copied into the schema, llms or
// markdown output. A run that contains a "?" can never be declared crosstalk.
function pgParseCrosstalk(attr) {
  return (attr || '').split(/\s+/).filter(function(s) { return s.length > 0; }).map(function(s) { return parseInt(s, 10); });
}

// the host run starting at run.startMs is declared crosstalk (and is not a question)
function pgIsDeclaredCrosstalk(declared, run) {
  return declared.indexOf(run.startMs) !== -1 && run.text.indexOf('?') === -1;
}

function pgDecode(s) {
  var named = { hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', amp: '&',
                lt: '<', gt: '>', quot: '"', apos: "'", mdash: '\u2014', ndash: '\u2013', nbsp: '\u00a0', middot: '\u00b7' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, function(m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(m, n) { return String.fromCodePoint(parseInt(n, 10)); })
    .replace(/&([a-z]+);/gi, function(m, n) { return named[n.toLowerCase()] !== undefined ? named[n.toLowerCase()] : m; });
}

function pgText(innerHtml) {
  return pgDecode(innerHtml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function pgClock(sec) {
  return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
}

function pgRange(text) {
  var m = (text || '').match(/(\d+):(\d\d)\D+?(\d+):(\d\d)/);
  return m ? [parseInt(m[1], 10) * 60 + parseInt(m[2], 10), parseInt(m[3], 10) * 60 + parseInt(m[4], 10)] : null;
}

// ---- transcript.vtt: tokens with cue + speaker ----

function pgToSec(ts) {
  var p = ts.trim().split(' ')[0].split(':');
  if (p.length === 3) return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + parseFloat(p[2]);
  return parseInt(p[0], 10) * 60 + parseFloat(p[1]);
}

function pgParseVtt(txt) {
  var cues = [];
  var blocks = txt.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').split(/\n\n+/);
  for (var i = 0; i < blocks.length; i++) {
    var lines = blocks[i].trim().split('\n');
    var ti = -1;
    for (var j = 0; j < lines.length; j++) { if (lines[j].indexOf('-->') !== -1) { ti = j; break; } }
    if (ti < 0) continue;
    var parts = lines[ti].split('-->');
    var s = pgToSec(parts[0]), e = pgToSec(parts[1]);
    if (isNaN(s) || isNaN(e)) continue;
    cues.push({ s: s, e: e, t: lines.slice(ti + 1).join(' ').trim() });
  }
  return cues;
}

function pgNorm(text) {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\u2014\u2013\-\u2026]/g, ' ')
    .split(/\s+/)
    .map(function(w) { return w.toLowerCase().replace(/[^a-z0-9]/g, ''); })
    .filter(function(w) { return w.length > 0; });
}

// Every token carries its cue, its speaker and the piece (a run of one speaker's words inside one cue) it came from.
// The returned array also carries .pieces, the raw text of each piece, so a host turn can be shown word for word.
function pgTokens(cues) {
  var out = [];
  var allPieces = [];
  var spk = '';
  var re = new RegExp('(' + PG_SPEAKERS.join('|') + '):\\s*|\\b(casey|adam|simon)_\\d+_[0-9-]+_\\d+:\\s*', 'g');
  cues.forEach(function(c, ci) {
    var last = 0, m, cur = spk, pieces = [];
    re.lastIndex = 0;
    while ((m = re.exec(c.t)) !== null) {
      if (m.index > last) pieces.push({ spk: cur, text: c.t.slice(last, m.index) });
      cur = m[1] || PG_SPEAKER_ALIASES[m[2]];
      last = m.index + m[0].length;
    }
    pieces.push({ spk: cur, text: c.t.slice(last) });
    spk = cur;
    pieces.forEach(function(p) {
      var pc = allPieces.length;
      allPieces.push({ spk: p.spk, text: p.text.replace(/\s+/g, ' ').trim(), cue: ci });
      pgNorm(p.text).forEach(function(w) { out.push({ w: w, cue: ci, spk: p.spk, pc: pc }); });
    });
  });
  out.pieces = allPieces;
  return out;
}

// ordered match of seg starting exactly at v[from]; later words may skip a few
// same-speaker words (false starts, repeats) and any amount of other-speaker talk
function pgMatchAt(seg, v, from) {
  var vi = from, spk = v[from].spk;
  for (var si = 0; si < seg.length; si++) {
    var found = -1;
    if (si === 0) {
      if (v[vi].w === seg[0]) found = vi;
    } else {
      var same = 0, other = 0;
      for (var k = 0; vi + k < v.length; k++) {
        var t = v[vi + k];
        if (t.w === seg[si] && t.spk === spk) { found = vi + k; break; }
        if (t.spk === spk) same++; else other++;
        if (same > 8 || other > 60) break;
      }
    }
    if (found < 0) return -1;
    vi = found + 1;
  }
  return vi - 1;
}

function pgFind(seg, v, cues, fromIdx, hintSec, spk) {
  var cands = [];
  for (var i = fromIdx; i < v.length; i++) {
    if (v[i].w !== seg[0]) continue;
    var last = pgMatchAt(seg, v, i);
    if (last >= 0) cands.push({ first: i, last: last, skip: (last - i + 1) - seg.length });
  }
  if (!cands.length) return null;
  // The first segment (hintSec given) is placed by where its words are really spoken, not by where the page says they
  // are. Among the places the whole segment matches, the tightest match wins (fewest skipped words, other speakers'
  // included) and only then the one nearest the page's own start time. Before, the page's own time was the only
  // tie-break, so a start that sat on an earlier, loosely matching "the" (q9 passage 2, 20:05 instead of 20:13)
  // confirmed itself and passed the timing-vtt check.
  function score(c) {
    var d = hintSec === null ? 0 : Math.abs(cues[v[c.first].cue].s - hintSec);
    return [v[c.first].spk === spk ? 0 : 1, hintSec === null ? 0 : c.skip, d];
  }
  function less(a, b) { for (var q = 0; q < 3; q++) { if (a[q] !== b[q]) return a[q] < b[q]; } return false; }
  var best = cands[0], bestScore = score(best);
  for (var k = 1; k < cands.length; k++) {
    var sc = score(cands[k]);
    if (less(sc, bestScore)) { best = cands[k]; bestScore = sc; }
  }
  return best;
}

// a segment with an unmarked cut inside can't be matched end to end, so anchor on
// its first and last words instead
function pgFindAnchored(seg, v, cues, fromIdx, hintSec, spk) {
  var K = Math.min(8, seg.length);
  var head = pgFind(seg.slice(0, K), v, cues, fromIdx, hintSec, spk);
  if (!head) return null;
  var tail = seg.slice(seg.length - K);
  var expect = head.first + Math.round(seg.length * 1.1);
  var best = -1;
  for (var i = head.last; i < v.length; i++) {
    if (v[i].w !== tail[0]) continue;
    var last = pgMatchAt(tail, v, i);
    if (last < 0) continue;
    if (best < 0 || Math.abs(last - expect) < Math.abs(best - expect)) best = last;
  }
  return best < 0 ? null : { first: head.first, last: best };
}

// returns { startMs, endMs } of the cue holding the first kept word / the cue holding the last kept word
function pgLocate(text, v, cues, hintSec, spk) {
  var segs = text.split('\u2026').map(pgNorm).filter(function(s) { return s.length > 0; });
  var idx = 0, firstTok = -1, lastTok = -1;
  for (var si = 0; si < segs.length; si++) {
    var loc = pgFind(segs[si], v, cues, si === 0 ? 0 : idx, si === 0 ? hintSec : null, spk) ||
              pgFindAnchored(segs[si], v, cues, si === 0 ? 0 : idx, si === 0 ? hintSec : null, spk);
    if (!loc) return null;
    if (si === 0) firstTok = loc.first;
    lastTok = loc.last;
    idx = loc.last + 1;
  }
  if (firstTok < 0) return null;
  return { startMs: Math.round(cues[v[firstTok].cue].s * 1000), endMs: Math.round(cues[v[lastTok].cue].e * 1000) };
}

// ---- host speech inside an answer (editorial rule 8) ----
//
// Follows each segment of a passage (the text between two "…") through transcript.vtt and looks at what sits
// between the guest words that were kept:
//   joins  host speech between two guest words that the page shows back to back, with no "…"   -> never allowed
//   cuts   host speech inside a stretch the page replaced with "…"                              -> allowed, but the
//          host's words must be shown with the answer and the answer must carry the "Ellipsis added" tag
// A host turn is { spk, text, startMs, endMs }: the host's exact words from the cues, and the first and last cue time.

// ordered match of seg starting exactly at v[from], returning the token index of every matched word.
// Unlike pgMatchAt it lets any amount of other-speaker talk sit between two matched words (up to PG_HOST_SPAN_MAX),
// so the caller can see it. Same-speaker words may still be skipped (false starts, repeats), as in pgMatchAt.
function pgMatchPath(seg, v, from) {
  var spk = v[from].spk, path = [], vi = from;
  for (var si = 0; si < seg.length; si++) {
    var found = -1;
    if (si === 0) {
      if (v[vi].w === seg[0]) found = vi;
    } else {
      var same = 0;
      for (var k = 0; vi + k < v.length && k < PG_HOST_SPAN_MAX; k++) {
        var t = v[vi + k];
        if (t.spk !== spk) continue;
        if (t.w === seg[si]) { found = vi + k; break; }
        same++;
        if (same > 8) break;
      }
    }
    if (found < 0) return null;
    path.push(found);
    vi = found + 1;
  }
  return path;
}

function pgFindPath(seg, v, cues, fromIdx, hintSec, spk) {
  var best = null, bestScore = [0, 0];
  for (var i = fromIdx; i < v.length; i++) {
    if (v[i].w !== seg[0] || v[i].spk !== spk) continue;
    var path = pgMatchPath(seg, v, i);
    if (!path) continue;
    var sc = hintSec === null ? [0, 0] : [(path[path.length - 1] - path[0] + 1) - seg.length, Math.abs(cues[v[i].cue].s - hintSec)];
    if (best === null || sc[0] < bestScore[0] || (sc[0] === bestScore[0] && sc[1] < bestScore[1])) { best = path; bestScore = sc; }
    if (hintSec === null) break;
  }
  return best;
}

// the other speaker's turns between guest tokens a and b (exclusive), with their exact words and times
function pgHostBetween(v, cues, a, b, spk) {
  var pieces = v.pieces, raw = [], cur = null;
  for (var k = a + 1; k < b; k++) {
    var t = v[k];
    if (t.spk === spk) { cur = null; continue; }
    if (cur && cur.spk === t.spk) { cur.lastPc = t.pc; cur.lastCue = t.cue; continue; }
    cur = { spk: t.spk, firstPc: t.pc, lastPc: t.pc, firstCue: t.cue, lastCue: t.cue };
    raw.push(cur);
  }
  return raw.map(function(c) {
    var words = [];
    for (var p = c.firstPc; p <= c.lastPc; p++) { if (pieces[p].spk === c.spk && pieces[p].text) words.push(pieces[p].text); }
    var said = words.join(' ').replace(/\s+/g, ' ').trim();
    return { spk: c.spk, text: said,
             startMs: Math.round(cues[c.firstCue].s * 1000), endMs: Math.round(cues[c.lastCue].e * 1000) };
  });
}

// ok = false when the passage's words could not be followed through the transcript (the verbatim and timing gates
// report that); otherwise the host turns found as joins (no "…") and as cuts (at a "…")
function pgPassageHostCuts(text, v, cues, hintSec, spk) {
  var segs = text.split('\u2026').map(pgNorm).filter(function(s) { return s.length > 0; });
  var res = { ok: true, joins: [], cuts: [], hostOnlyCuts: [] };
  var idx = 0, prevLast = -1;
  for (var si = 0; si < segs.length; si++) {
    var path = pgFindPath(segs[si], v, cues, si === 0 ? 0 : idx, si === 0 ? hintSec : null, spk);
    if (!path) return { ok: false, joins: [], cuts: [], hostOnlyCuts: [] };
    for (var j = 1; j < path.length; j++) {
      if (path[j] - path[j - 1] > 1) res.joins = res.joins.concat(pgHostBetween(v, cues, path[j - 1], path[j], spk));
    }
    if (prevLast >= 0) {
      var between = pgHostBetween(v, cues, prevLast, path[0], spk);
      res.cuts = res.cuts.concat(between);
      var guestIn = false;
      for (var gk = prevLast + 1; gk < path[0]; gk++) { if (v[gk].spk === spk) { guestIn = true; break; } }
      if (!guestIn && between.length) res.hostOnlyCuts.push(between);
    }
    prevLast = path[path.length - 1];
    idx = prevLast + 1;
  }
  return res;
}

// ---- parse one answer page ----

function pgParsePage(html) {
  var arts = [];
  var re = /<article class="qa-item"[^>]*>[\s\S]*?<\/article>/g;
  var m, prevEnd = 0;
  while ((m = re.exec(html)) !== null) {
    var a = m[0];
    var pre = html.slice(prevEnd, m.index);
    var cut = Math.max(
      pre.lastIndexOf('</article>') >= 0 ? pre.lastIndexOf('</article>') + 10 : -1,
      pre.lastIndexOf('<div class="qa-list">') >= 0 ? pre.lastIndexOf('<div class="qa-list">') + 21 : -1);
    var region = pre.slice(cut < 0 ? 0 : cut);
    var labels = [];
    var lre = /<span class="answer-label answer-label--([a-z-]+)"[^>]*>([^<]*)<\/span>/g, lm;
    while ((lm = lre.exec(region)) !== null) labels.push({ cls: lm[1], text: lm[2] });
    // "Ellipsis added" tags (rule 8) sit with the label, before the article
    var tags = [];
    var tre = /<span class="answer-tag[^"]*"[^>]*>([^<]*)<\/span>/g, tm;
    while ((tm = tre.exec(region)) !== null) tags.push(tm[1].trim());
    // host words shown with the answer (rule 8)
    var hostQs = [];
    var hre = /<div class="question-field question-field--host"([^>]*)>([\s\S]*?)<\/div>/g, hm;
    while ((hm = hre.exec(a)) !== null) {
      var hs = hm[1].match(/data-host-speaker="([^"]*)"/), hst = hm[1].match(/data-vtt-start="(\d+)"/), het = hm[1].match(/data-vtt-end="(\d+)"/);
      var hwho = hm[2].match(/<span class="question-speaker"[^>]*>([\s\S]*?)<\/span>/);
      var htxt = hm[2].match(/<span class="question-text"[^>]*>([\s\S]*?)<\/span>/);
      var hrange = hm[2].match(/<span class="question-time"[^>]*>([\s\S]*?)<\/span>/);
      hostQs.push({
        speaker: hs ? pgDecode(hs[1]) : '', startMs: hst ? parseInt(hst[1], 10) : null, endMs: het ? parseInt(het[1], 10) : null,
        shownSpeaker: hwho ? pgText(hwho[1]) : '', text: htxt ? pgText(htxt[1]) : '', shownRange: hrange ? pgRange(pgText(hrange[1])) : null
      });
    }

    var ds = a.match(/data-vtt-start="(\d+)"/), de = a.match(/data-vtt-end="(\d+)"/);
    var paper = a.match(/<div class="qa-item__paper">([\s\S]*?)<\/div>/);
    var passages = [];
    if (paper) {
      var pm = paper[1].match(/<p[^>]*>[\s\S]*?<\/p>/g) || [];
      pm.forEach(function(p) {
        var s = p.match(/data-vtt-start="(\d+)"/), e = p.match(/data-vtt-end="(\d+)"/);
        passages.push({ text: pgText(p), startMs: s ? parseInt(s[1], 10) : null, endMs: e ? parseInt(e[1], 10) : null });
      });
    }
    var anchors = [];
    var are = /<a href="([^"]*)" class="citation-ts"[^>]*aria-label="([^"]*)"[^>]*>([^<]*)<\/a>/g, am;
    while ((am = are.exec(a)) !== null) {
      var tq = am[1].match(/\?t=(\d+)/);
      anchors.push({ t: tq ? parseInt(tq[1], 10) : null, aria: pgRange(am[2]), vis: pgRange(am[3]) });
    }
    var spkM = a.match(/data-vtt-speaker="([^"]+)"/);
    arts.push({
      id: (a.match(/id="(q\d+)"/) || [])[1] || '?',
      question: extractQuestionText(a),
      speaker: spkM ? spkM[1] : '',
      dataStart: ds ? parseInt(ds[1], 10) : null,
      dataEnd: de ? parseInt(de[1], 10) : null,
      labels: labels, tags: tags, hostQs: hostQs, passages: passages, anchors: anchors,
      // host runs declared as crosstalk (start times in ms); read from the article's own opening tag only
      crosstalk: pgParseCrosstalk((((a.match(/^<article[^>]*>/) || [''])[0]).match(/data-crosstalk="([^"]*)"/) || [])[1]),
      hasEllipsis: passages.some(function(p) { return p.text.indexOf('\u2026') !== -1; })
    });
    prevEnd = m.index + a.length;
  }
  return arts;
}

function passageGates() {
  var answersDir = path.join(OUT, 'answers');
  if (!fs.existsSync(answersDir)) return;
  var found = 0;
  var slugs = fs.readdirSync(answersDir).filter(function(d) {
    return fs.statSync(path.join(answersDir, d)).isDirectory();
  });

  function fail(check, slug, art, msg) {
    found++;
    var label = art ? art.id.toUpperCase() + ': ' : '';
    console.error('\u2717 ' + check.toUpperCase() + ' (' + slug + ') ' + label + msg);
    reportError(check, slug, art ? art.id : null, art ? art.question : null, msg);
  }

  for (var si = 0; si < slugs.length; si++) {
    var slug = slugs[si];
    var file = path.join(answersDir, slug, 'index.html');
    if (!fs.existsSync(file)) continue;
    var html = fs.readFileSync(file, 'utf8');
    if (html.indexOf('class="qa-item"') === -1) continue;
    var arts = pgParsePage(html);

    // schema nodes
    var graph = [];
    try { graph = JSON.parse(getJsonLdBlock(html))['@graph'] || []; } catch (e) { graph = []; }
    var clips = {}, quotes = {}, hostQuotes = {}, clipTotal = 0, quoteTotal = 0;
    graph.forEach(function(n) {
      if (n['@type'] === 'Clip') { clips[n['@id']] = n; clipTotal++; }
      if (n['@type'] === 'Quotation') {
        // a host question shown with an answer (rule 8) is its own Quotation, by the host; it is not an answer passage
        if (/-host-question-\d+$/.test(String(n['@id']))) hostQuotes[n['@id']] = n;
        else { quotes[n['@id']] = n; quoteTotal++; }
      }
    });
    var passageTotal = arts.reduce(function(sum, a) { return sum + a.passages.length; }, 0);
    if (clipTotal !== passageTotal) {
      fail('clip-count', slug, null, passageTotal + ' passage' + (passageTotal === 1 ? '' : 's') + ' on the page but ' +
        clipTotal + ' schema Clip node' + (clipTotal === 1 ? '' : 's') + ' \u2014 each passage needs its own Clip.');
    }
    if (quoteTotal !== passageTotal) {
      fail('clip-count', slug, null, passageTotal + ' passage' + (passageTotal === 1 ? '' : 's') + ' on the page but ' +
        quoteTotal + ' schema Quotation node' + (quoteTotal === 1 ? '' : 's') + ' \u2014 each passage needs its own Quotation.');
    }

    // transcript.vtt for the word-position check
    var vttPath = path.join(answersDir, slug, 'transcript.vtt');
    var cues = fs.existsSync(vttPath) ? pgParseVtt(fs.readFileSync(vttPath, 'utf8')) : [];
    var vtok = cues.length ? pgTokens(cues) : [];
    if (!cues.length) {
      fail('timing-vtt', slug, null, 'transcript.vtt is missing or has no readable cues, so no passage time can be checked against the transcript.');
    }

    for (var ai = 0; ai < arts.length; ai++) {
      var art = arts[ai];
      var n = art.passages.length;
      var qid = art.id;

      // label
      var want = art.hasEllipsis ? 'edited' : 'verbatim';
      if (art.labels.length !== 1) {
        fail('label', slug, art, art.labels.length === 0
          ? 'has no Verbatim/Edited label. Every answer needs exactly one.'
          : 'has ' + art.labels.length + ' labels (' + art.labels.map(function(l) { return l.text; }).join(' + ') + '). Every answer needs exactly one.');
      } else {
        var lab = art.labels[0];
        var okText = /^(Verbatim|Edited)( quote)?$/.test(lab.text);
        if (lab.cls.indexOf(want) !== 0 || !okText || lab.text.toLowerCase().indexOf(want) !== 0) {
          fail('label', slug, art, 'is labelled "' + lab.text + '" but ' + (art.hasEllipsis
            ? 'the answer contains "\u2026" (a marked cut), so it must be Edited.'
            : 'the answer has no "\u2026", so it must be Verbatim.') + ' (Rule: Edited if any passage contains "\u2026", otherwise Verbatim.)');
        }
      }

      // one play link per passage
      if (art.anchors.length !== n) {
        fail('passage-time', slug, art, n + ' passage' + (n === 1 ? '' : 's') + ' but ' + art.anchors.length +
          ' start\u2013end time/play link' + (art.anchors.length === 1 ? '' : 's') + '. Every passage needs its own (Rule 4: one passage, one timestamp).');
      }

      var envMin = null, envMax = null;
      for (var pi = 0; pi < n; pi++) {
        var p = art.passages[pi];
        var tag = n > 1 ? 'passage ' + (pi + 1) : 'the answer';
        if (p.startMs === null || p.endMs === null || !(p.endMs > p.startMs)) {
          fail('passage-time', slug, art, tag + ' has no start\u2013end time of its own (data-vtt-start / data-vtt-end on the passage).');
          continue;
        }
        envMin = envMin === null ? p.startMs : Math.min(envMin, p.startMs);
        envMax = envMax === null ? p.endMs : Math.max(envMax, p.endMs);
        var sS = Math.floor(p.startMs / 1000), eS = Math.ceil(p.endMs / 1000);
        var shown = pgClock(sS) + '\u2013' + pgClock(eS);

        // every place the time is written must agree
        var disagree = [];
        var an = art.anchors[pi];
        if (an) {
          if (!an.vis) disagree.push('visible \u25B6 range is missing');
          else if (an.vis[0] !== sS || an.vis[1] !== eS) disagree.push('visible \u25B6 range shows ' + pgClock(an.vis[0]) + '\u2013' + pgClock(an.vis[1]));
          if (an.t !== sS) disagree.push('link ?t=' + an.t);
          if (!an.aria) disagree.push('aria-label has no time');
          else if (an.aria[0] !== sS || an.aria[1] !== eS) disagree.push('aria-label says ' + pgClock(an.aria[0]) + '\u2013' + pgClock(an.aria[1]));
        }
        var cid = 'https://citedconversations.com/answers/' + slug + '/#' + qid + '-clip' + (n > 1 ? '-' + (pi + 1) : '');
        var qidq = 'https://citedconversations.com/answers/' + slug + '/#' + qid + '-quotation' + (n > 1 ? '-' + (pi + 1) : '');
        var clip = clips[cid];
        if (!clip) {
          disagree.push('schema Clip ' + cid.split('#')[1] + ' is missing');
        } else {
          var cu = String(clip.url || '').match(/\?t=(\d+)/);
          if (clip.startOffset !== sS || clip.endOffset !== eS) disagree.push('schema Clip offsets ' + clip.startOffset + '\u2013' + clip.endOffset + 's');
          if (!cu || parseInt(cu[1], 10) !== sS) disagree.push('schema Clip url ?t=' + (cu ? cu[1] : 'none'));
        }
        if (disagree.length) {
          fail('timing-agree', slug, art, tag + ' is ' + shown + ' (' + sS + '\u2013' + eS + 's) but ' + disagree.join('; ') + '. Every place must show the same time.');
        }

        // schema Quotation text == visible text
        var quo = quotes[qidq];
        if (!quo) {
          fail('quotation-text', slug, art, 'schema Quotation ' + qidq.split('#')[1] + ' is missing for ' + tag + '.');
        } else if (quo.text !== p.text) {
          var at = 0;
          while (at < p.text.length && at < String(quo.text).length && p.text.charAt(at) === String(quo.text).charAt(at)) at++;
          fail('quotation-text', slug, art, 'schema Quotation text differs from the visible text of ' + tag + ' at character ' + at +
            ': page \u201C' + p.text.slice(Math.max(0, at - 10), at + 25) + '\u201D vs schema \u201C' + String(quo.text).slice(Math.max(0, at - 10), at + 25) + '\u201D.');
        }

        // times vs the words in transcript.vtt
        if (vtok.length) {
          var loc = pgLocate(p.text, vtok, cues, p.startMs / 1000, art.speaker);
          if (!loc) {
            fail('timing-vtt', slug, art, tag + ': its words could not be found in transcript.vtt, so its time cannot be verified.');
          } else if (Math.abs(loc.startMs - p.startMs) > PG_VTT_TOLERANCE_MS || Math.abs(loc.endMs - p.endMs) > PG_VTT_TOLERANCE_MS) {
            fail('timing-vtt', slug, art, tag + ' is marked ' + (p.startMs / 1000).toFixed(1) + '\u2013' + (p.endMs / 1000).toFixed(1) +
              's but its first and last words are spoken at ' + (loc.startMs / 1000).toFixed(1) + '\u2013' + (loc.endMs / 1000).toFixed(1) +
              's in transcript.vtt (allowed difference ' + (PG_VTT_TOLERANCE_MS / 1000) + 's).');
          }
        }
      }

      // article-level window must be the envelope of its passages
      if (envMin !== null && (art.dataStart !== envMin || art.dataEnd !== envMax)) {
        fail('timing-agree', slug, art, 'article data-vtt window ' + art.dataStart + '\u2013' + art.dataEnd + 'ms does not match its passages (' + envMin + '\u2013' + envMax + 'ms).');
      }

      // Host speech inside the answer (editorial rule 8).
      //  host-join      guest words joined across host speech with no "\u2026"
      //  host-question  a cut over host speech needs the host's exact words shown with the answer, attributed to the
      //                 host, and the "Ellipsis added" tag
      var hostNeeded = [];
      var crossUsed = {};
      var followed = true;
      if (vtok.length) {
        for (var hi = 0; hi < n; hi++) {
          var hp = art.passages[hi];
          if (hp.startMs === null) { followed = false; continue; }
          var hc = pgPassageHostCuts(hp.text, vtok, cues, hp.startMs / 1000, art.speaker);
          if (!hc.ok) { followed = false; continue; }
          var hwhere = n > 1 ? 'passage ' + (hi + 1) : 'the answer';
          // every host run inside the span is declared: a shown host question (a cut, below) or crosstalk (data-crosstalk)
          hc.joins.concat(hc.cuts).forEach(function(t) {
            if (art.crosstalk.indexOf(t.startMs) === -1) return;
            crossUsed[t.startMs] = true;
            if (!pgIsDeclaredCrosstalk(art.crosstalk, t)) {
              fail('host-question', slug, art, hwhere + ': the host run at ' + pgClock(Math.floor(t.startMs / 1000)) + '\u2013' + pgClock(Math.ceil(t.endMs / 1000)) +
                ' (' + t.spk + ' \u201C' + t.text + '\u201D) is declared crosstalk in data-crosstalk but it contains a \u201C?\u201D. A host question can never be crosstalk. ' +
                'Remove it from data-crosstalk, mark the cut with \u201C\u2026\u201D, show the question with the answer and add the \u201CEllipsis added\u201D tag (editorial rule 8).');
            }
          });
          hc.joins.forEach(function(t) {
            if (art.crosstalk.indexOf(t.startMs) !== -1) return;
            fail('host-join', slug, art, hwhere + ' joins the guest\u2019s words across ' + t.spk + ' speaking (' + pgClock(Math.floor(t.startMs / 1000)) +
              '\u2013' + pgClock(Math.ceil(t.endMs / 1000)) + ', \u201C' + t.text + '\u201D, starts at ' + t.startMs + ' ms) and the page does not say what that host run is. ' +
              (t.text.indexOf('?') === -1
                ? 'If it does not help the answer (the host\u2019s words do not shape what the guest says next), declare it crosstalk: add ' + t.startMs + ' to data-crosstalk on this article. Otherwise mark the join with \u201C\u2026\u201D, '
                : 'A host run with a \u201C?\u201D can never be crosstalk. Mark the join with \u201C\u2026\u201D, ') +
              'show the host\u2019s words with the answer and add the \u201CEllipsis added\u201D tag (editorial rule 8).');
          });
          hostNeeded = hostNeeded.concat(hc.cuts.filter(function(t) { return art.crosstalk.indexOf(t.startMs) === -1; }));
          // a "\u2026" that covers only declared crosstalk replaces nothing the guest said: crosstalk gets no "\u2026"
          hc.hostOnlyCuts.forEach(function(group) {
            var allCross = group.every(function(t) { return pgIsDeclaredCrosstalk(art.crosstalk, t); });
            if (!allCross) return;
            fail('host-join', slug, art, hwhere + ' has a \u201C\u2026\u201D where only host crosstalk sits between the guest\u2019s words (' +
              group.map(function(t) { return pgClock(Math.floor(t.startMs / 1000)) + ' ' + t.spk + ' \u201C' + t.text + '\u201D'; }).join('; ') +
              '). Crosstalk gets no \u201C\u2026\u201D: remove it so the guest\u2019s words read straight through (editorial rule 8 exception).');
          });
        }
      }
      // a declaration that matches no host run inside this answer's span is stale and fails (only when every passage could be followed)
      if (vtok.length && followed) {
        art.crosstalk.forEach(function(ms) {
          if (crossUsed[ms]) return;
          fail('host-crosstalk', slug, art, 'data-crosstalk lists ' + ms + ' but no host run starts there inside this answer\u2019s span. Remove it or correct the time.');
        });
      }
      if (hostNeeded.length) {
        var needSummary = hostNeeded.map(function(t) { return t.spk + ' \u201C' + t.text + '\u201D (' + pgClock(Math.floor(t.startMs / 1000)) + '\u2013' + pgClock(Math.ceil(t.endMs / 1000)) + ')'; }).join('; ');
        var crossHint = hostNeeded.some(function(t) { return t.text.indexOf('?') !== -1; }) ? '' :
          ' If these host words do not help the answer (the host\u2019s words do not shape what the guest says next), declare each as crosstalk instead: data-crosstalk="' +
          hostNeeded.map(function(t) { return t.startMs; }).join(' ') + '" on the article.';
        if (art.tags.length !== 1 || art.tags[0] !== 'Ellipsis added') {
          fail('host-question', slug, art, 'a \u201C\u2026\u201D in this answer replaces host speech (' + needSummary + ') but the answer ' +
            (art.tags.length === 0 ? 'has no \u201CEllipsis added\u201D tag.' : 'has the tag(s) \u201C' + art.tags.join('\u201D, \u201C') + '\u201D instead of exactly one \u201CEllipsis added\u201D.') + ' (Rule 8.)' + crossHint);
        }
        if (art.hostQs.length === 0) {
          fail('host-question', slug, art, 'a \u201C\u2026\u201D in this answer replaces host speech (' + needSummary + ') but the host\u2019s words are not shown with the answer. ' +
            'Show them word for word, attributed to the host (rule 8).' + crossHint);
        } else if (art.hostQs.length !== hostNeeded.length) {
          fail('host-question', slug, art, art.hostQs.length + ' host turn' + (art.hostQs.length === 1 ? ' is' : 's are') + ' shown but ' + hostNeeded.length +
            ' ' + (hostNeeded.length === 1 ? 'was' : 'were') + ' cut from the answer: ' + needSummary + '.' + crossHint);
        } else {
          for (var qi = 0; qi < hostNeeded.length; qi++) {
            var need = hostNeeded[qi], shownQ = art.hostQs[qi];
            var qprob = [];
            if (shownQ.text !== need.text) qprob.push('shows \u201C' + shownQ.text + '\u201D but the transcript has \u201C' + need.text + '\u201D');
            if (shownQ.speaker !== need.spk || shownQ.shownSpeaker !== need.spk) qprob.push('is not attributed to ' + need.spk);
            if (shownQ.startMs !== need.startMs || shownQ.endMs !== need.endMs) qprob.push('has times ' + shownQ.startMs + '\u2013' + shownQ.endMs + 'ms but the cues are ' + need.startMs + '\u2013' + need.endMs + 'ms');
            var wantR = [Math.floor(need.startMs / 1000), Math.ceil(need.endMs / 1000)];
            if (!shownQ.shownRange || shownQ.shownRange[0] !== wantR[0] || shownQ.shownRange[1] !== wantR[1]) qprob.push('shows the time range ' + (shownQ.shownRange ? pgClock(shownQ.shownRange[0]) + '\u2013' + pgClock(shownQ.shownRange[1]) : 'none') + ' instead of ' + pgClock(wantR[0]) + '\u2013' + pgClock(wantR[1]));
            if (qprob.length) fail('host-question', slug, art, 'the shown host question ' + (qi + 1) + ' ' + qprob.join('; ') + '.');
          }
        }
      }
      // each shown host question is its own schema Quotation, by the host, with the same words
      art.hostQs.forEach(function(hq, hi2) {
        var hqid = 'https://citedconversations.com/answers/' + slug + '/#' + qid + '-host-question-' + (hi2 + 1);
        var hqn = hostQuotes[hqid];
        if (!hqn) fail('quotation-text', slug, art, 'schema Quotation ' + hqid.split('#')[1] + ' is missing for the shown host question ' + (hi2 + 1) + '.');
        else if (hqn.text !== hq.text) fail('quotation-text', slug, art, 'schema Quotation ' + hqid.split('#')[1] + ' text \u201C' + hqn.text + '\u201D differs from the visible host question \u201C' + hq.text + '\u201D.');
      });
    }
  }

  if (found > 0) {
    console.error('\n\u2717 PASSAGE GATES \u2014 ' + found + ' problem' + (found === 1 ? '' : 's') + ' found. See dist/build-report.json.');
    writeReport();
    process.exit(1);
  }
  console.log('Passage gates passed (timing, labels, schema text, clip count).');
}

// ── Encoding gate ─────────────────────────────────────────────────────────────
// Fails if any served text file is not valid UTF-8 or contains mojibake — UTF-8
// bytes that were read as Latin-1/Windows-1252 and re-saved (an em dash, an arrow or an
// accented letter turns into two or three odd characters starting with a-circumflex or
// A-tilde) or stray C1 control characters.

var PG_TEXT_EXT = /\.(html|txt|vtt|md|json|xml|css|js|svg|webmanifest)$/i;
var PG_MOJIBAKE = [
  [/\u00e2[\u0080-\u00bf\u20ac\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u2122]/, '\u00e2 followed by a continuation byte (e.g. "\u00e2\u20ac" for an em dash, "\u00e2\u2013" for an arrow)'],
  [/[\u00c2\u00c3][\u0080-\u00bf]/, '\u00c2/\u00c3 followed by a continuation byte (e.g. "\u00c3\u00a9" for \u00e9)'],
  [/[\u0080-\u009f]/, 'a C1 control character']
];

// Known problem files, written down so they are visible instead of silent. These two IndexNow key files
// were already saved with bytes that are not valid text before the gate existed; the build warns instead of
// failing until someone rewrites them (an IndexNow key file must contain exactly the key).
var PG_ENCODING_WAIVERS = {
  'b3a7c9f2e1d4a8b6c0f3e5d7a2b4c6d8.txt': 'IndexNow key file whose content is not valid text',
  'c7d4e2f8a1b9c3d6e0f5a8b2c4d7e1f3.txt': 'IndexNow key file (the key in scripts/indexnow-submit.js) whose content is not valid text, so IndexNow cannot verify it'
};

function encodingCheck() {
  var found = 0;
  function walk(dir) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!PG_TEXT_EXT.test(e.name)) continue;
      var rel = path.relative(OUT, p);
      // machine-generated traffic telemetry (raw user-agent strings) is not site content; a stray byte there must not block a deploy
      if (/^data[\\\/]bot-traffic/.test(rel)) continue;
      var text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(p));
      } catch (err) {
        if (PG_ENCODING_WAIVERS[rel]) {
          var w1 = rel + ' is not valid UTF-8 (waived: ' + PG_ENCODING_WAIVERS[rel] + ')';
          console.warn('  \u26a0 ENCODING ' + w1);
          reportWarning('encoding', rel, null, null, w1);
          continue;
        }
        found++;
        var m1 = rel + ' is not valid UTF-8.';
        console.error('\u2717 ENCODING ' + m1);
        reportError('encoding', rel, null, null, m1);
        continue;
      }
      for (var k = 0; k < PG_MOJIBAKE.length; k++) {
        var hit = text.match(PG_MOJIBAKE[k][0]);
        if (hit) {
          found++;
          var at = text.indexOf(hit[0]);
          var ctx = text.slice(Math.max(0, at - 20), at + 20).replace(/\s+/g, ' ');
          var m2 = rel + ' contains garbled characters (' + PG_MOJIBAKE[k][1] + ') near \u201C' + ctx + '\u201D. ' +
                   'The file was saved with the wrong text encoding \u2014 re-save it as UTF-8.';
          console.error('\u2717 ENCODING ' + m2);
          reportError('encoding', rel, null, null, m2);
          break;
        }
      }
    }
  }
  walk(OUT);
  if (found > 0) {
    console.error('\n\u2717 ENCODING GATE \u2014 ' + found + ' file' + (found === 1 ? '' : 's') + ' with garbled or invalid text.');
    writeReport();
    process.exit(1);
  }
  console.log('Encoding check passed.');
}

// ── Changelog check ───────────────────────────────────────────────────────────
// Reads data/changelog.json and warns if any answer page has a dateModified
// in its JSON-LD that is newer than the latest entry for that page in the log.

function changelogCheck() {
  var changelogPath = path.join(OUT, 'data', 'changelog.json');
  if (!fs.existsSync(changelogPath)) {
    console.warn('\u26a0\ufe0f  No data/changelog.json found \u2014 skipping changelog check.');
    return;
  }
  var log       = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
  var answersDir = path.join(OUT, 'answers');
  if (!fs.existsSync(answersDir)) return;

  var slugs = fs.readdirSync(answersDir).filter(function(d) {
    return fs.statSync(path.join(answersDir, d)).isDirectory();
  });

  var warnings = [];
  for (var si = 0; si < slugs.length; si++) {
    var slug = slugs[si];
    var file = path.join(answersDir, slug, 'index.html');
    if (!fs.existsSync(file)) continue;
    var html     = fs.readFileSync(file, 'utf8');
    var dmMatch  = html.match(/"dateModified":\s*"(\d{4}-\d{2}-\d{2})"/);
    if (!dmMatch) continue;
    var dateModified = dmMatch[1];
    var entries = log.entries.filter(function(e) {
      return e.pages.includes(slug) || e.pages.includes('*');
    });
    if (!entries.length) {
      warnings.push(slug + ': dateModified is ' + dateModified + ' but no changelog entries exist for this page.');
      continue;
    }
    var latest = entries.map(function(e) { return e.date; }).sort().pop();
    if (dateModified > latest) {
      warnings.push(slug + ': dateModified ' + dateModified + ' is newer than latest changelog entry ' + latest +
                    ' \u2014 add a changelog entry for this change.');
    }
  }
  if (warnings.length) {
    console.warn('\n\u26a0\ufe0f  CHANGELOG WARNINGS \u2014 add entries to data/changelog.json:');
    warnings.forEach(function(w) { console.warn('   \u2022 ' + w); });
  } else {
    console.log('Changelog check passed (' + slugs.length + ' answer page' + (slugs.length === 1 ? '' : 's') + ').');
  }
}

// ── Strict verbatim check (v2) ────────────────────────────────────────────────
// Casey's rule 4: the build fails if ANY quoted text doesn't match the VTT
// apart from marked ellipses and brackets.
//
// Algorithm:
//   1. Split page quote on ellipsis (…) → segments
//   2. Strip [bracket] words from each segment (permitted additions)
//   3. Normalize both: lowercase, strip ALL punctuation (including hyphens).
//      Em-dashes and en-dashes become spaces so "word—word" never merges.
//   4. For each segment, search the full VTT word stream for a contiguous match
//      starting from where the previous segment ended.
//   5. Ellipsis gaps may contain ANY VTT words (that is the point of the marker).
//   6. Fails on first mismatch; plain-English message names page, Q number,
//      question text, the offending words, and the transcript at that point.

// Extended fillers: um/uh/er/ah/hmm + discourse markers + phrase repeats (2–4 back)
var VTT_STRICT_FILLER   = new Set(['um','uh','er','ah','hmm','mm','mmhmm','yeah','yes','okay','ok']);
var VTT_DISCOURSE_FILLER = new Set(['right','yeah','well']);

function normVttWord(w) {
  // Strip ALL non-alphanumeric (including hyphens, apostrophes, punctuation)
  return w.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isFiller(w, p1, p2, p3, p4, midSeg) {
  var n = normVttWord(w);
  if (VTT_STRICT_FILLER.has(n)) return true;
  if (midSeg && VTT_DISCOURSE_FILLER.has(n)) return true;
  // Short trailing-hyphen false-start (Descript artifact: "th-", "ex-", "may-")
  if (w.endsWith('-') && n.length <= 3) return true;
  // Descript split-word false-starts: "th-this" → ['th-','this'] — skip the prefix
  if (/^[a-z]{1,2}-[a-z]/i.test(w)) return true;
  // Phrase repeats (2–4 back)
  if (p1 && n === normVttWord(p1)) return true;
  if (p2 && n === normVttWord(p2)) return true;
  if (p3 && n === normVttWord(p3)) return true;
  if (p4 && n === normVttWord(p4)) return true;
  return false;
}

// The other speaker's words are kept in the stream as one marker per turn (VTT_HOST_MARK + who + what they said), so a
// quote that runs straight across host speech cannot match: it needs a "…" there (editorial rule 8). The marker's
// text is never equal to a word of the page, and the host's words are available for the error message.
var VTT_HOST_MARK = '\u0001';

// The first cue time (ms) and full text of the host run each non-guest cue belongs to. A run is the consecutive cues of one
// other speaker between two of the guest's cues; it is the same run the passage gates look at, so the same data-crosstalk
// start time identifies it in both places.
function vttHostRuns(cues, speaker) {
  var byCue = [], cur = null;
  cues.forEach(function(c, i) {
    if (c.speaker === speaker) { cur = null; return; }
    if (cur && cur.speaker === c.speaker) cur.text += ' ' + c.text;
    else cur = { speaker: c.speaker, startMs: Math.round(c.startMs), text: c.text };
    byCue[i] = cur;
  });
  return byCue;
}

function buildVttWordStream(cues, startMs, endMs, speaker, declaredCrosstalk) {
  var SLACK   = 10000;
  var rawWords = [];
  var hostRuns = vttHostRuns(cues, speaker);
  cues.forEach(function(c, ci) {
    if (c.endMs < startMs - SLACK || c.startMs > endMs + SLACK) return;
    if (c.speaker !== speaker) {
      // a host run declared as crosstalk (data-crosstalk) is treated as if it were not there; a run with a "?" never is
      if (pgIsDeclaredCrosstalk(declaredCrosstalk, hostRuns[ci])) return;
      var last = rawWords.length - 1;
      var said = c.speaker + ': ' + c.text;
      if (last >= 0 && rawWords[last].charAt(0) === VTT_HOST_MARK && rawWords[last].indexOf(VTT_HOST_MARK + c.speaker + ': ') === 0) {
        rawWords[last] += ' ' + c.text;
      } else {
        rawWords.push(VTT_HOST_MARK + said);
      }
      return;
    }
    c.text.split(/\s+/).forEach(function(w) {
      if (!w) return;
      // Split Descript merged false-starts: ≤2 lowercase chars before internal hyphen
      // e.g. "th-this" → ["th-", "this"]
      if (/^[a-z]{1,2}-[a-z]/.test(w)) {
        var h = w.indexOf('-');
        rawWords.push(w.slice(0, h + 1));
        rawWords.push(w.slice(h + 1));
      } else {
        rawWords.push(w);
      }
    });
  });
  // Rejoin line-break hyphens: VTT sometimes splits compound words (like "AI-written",
  // "AI-ready") across cue boundaries — "AI-" ends one cue, "written" starts the next.
  // Only rejoin when the hyphen word contains an uppercase letter (abbreviation/proper
  // prefix like "AI-"); lowercase stutter prefixes ("th-", "ex-") are left as-is so
  // isFiller() can still recognize them.
  var merged = [];
  for (var i = 0; i < rawWords.length; i++) {
    if (rawWords[i].endsWith('-') && /[A-Z]/.test(rawWords[i]) && rawWords[i].charAt(0) !== VTT_HOST_MARK &&
        i + 1 < rawWords.length && rawWords[i + 1].charAt(0) !== VTT_HOST_MARK) {
      merged.push(rawWords[i] + rawWords[i + 1]);
      i++;
    } else {
      merged.push(rawWords[i]);
    }
  }
  // host runs declared as crosstalk were left out above (editorial rule 8 exception); every other host run stays as a marker
  return merged;
}

function normalizeSegment(text) {
  // Strip [bracket] added words, then split and normalize.
  // Em-dashes (—) and en-dashes (–) become spaces BEFORE normalization so that
  // "word—word" in a page answer doesn't collapse into the single token "wordword",
  // which would never match the VTT where those words are space-separated.
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\u2014\u2013]/g, ' ')
    .split(/\s+/)
    .map(normVttWord)
    .filter(function(w) { return w.length > 0; });
}

function matchSegment(segWords, vWords, from) {
  // Search for segWords as a contiguous sequence in vWords, starting from `from`.
  // Fillers in vWords are skipped transparently.
  for (var vi = from; vi < vWords.length; vi++) {
    if (normVttWord(vWords[vi]) !== segWords[0]) continue;
    var si = 0, vi2 = vi, ok = true;
    while (si < segWords.length) {
      if (vi2 >= vWords.length) { ok = false; break; }
      var nv = normVttWord(vWords[vi2]);
      var p1 = vi2 > 0 ? vWords[vi2-1] : undefined;
      var p2 = vi2 > 1 ? vWords[vi2-2] : undefined;
      var p3 = vi2 > 2 ? vWords[vi2-3] : undefined;
      var p4 = vi2 > 3 ? vWords[vi2-4] : undefined;
      if (nv === segWords[si]) { si++; vi2++; }
      else if (isFiller(vWords[vi2], p1, p2, p3, p4, si > 0)) { vi2++; }
      else { ok = false; break; }
    }
    if (ok) return { ok: true, start: vi, end: vi2 };
    // Keep searching — no early break on mismatch
  }
  return {
    ok: false,
    end: from
  };
}

function extractQuoteTexts(blockHtml, isSynthesisArticle) {
  function decodeEntities(s) {
    return s
      .replace(/\u2019|'/g, "'")
      .replace(/\u201C|"/g, '"')
      .replace(/\u201D|"/g, '"')
      .replace(/&rsquo;|&lsquo;|&apos;/g, "'")
      .replace(/&rdquo;|&ldquo;/g, '"')
      .replace(/&mdash;/g, '\u2014')
      .replace(/&ndash;/g, '\u2013')
      .replace(/&hellip;/g, '\u2026')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); });
  }
  if (isSynthesisArticle) {
    var texts = [];
    var srcRe = /<p[^>]*class="synthesis-source-text"[^>]*>([\s\S]*?)<\/p>/g;
    var sm;
    while ((sm = srcRe.exec(blockHtml)) !== null) {
      var t = decodeEntities(sm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (t.length > 5) texts.push(t);
    }
    return texts;
  } else {
    var m = blockHtml.match(/<div[^>]*class="qa-item__paper"[^>]*>([\s\S]*?)<\/div>/);
    if (!m) return [];
    // Extract each <p> element as a separate passage; join with … so the checker
    // treats each paragraph as an independent segment (not one giant cross-VTT span)
    var pMatches = m[1].match(/<p[^>]*>[\s\S]*?<\/p>/g) || [];
    if (pMatches.length === 0) {
      var t = decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      return t.length > 5 ? [t] : [];
    }
    var texts = pMatches.map(function(p) {
      return decodeEntities(p.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }).filter(function(t) { return t.length > 5; });
    return texts.length > 0 ? [texts.join(' \u2026 ')] : [];
  }
}

// When a segment does not match the transcript, see whether it WOULD match if the host's words were ignored. If so the
// quote joins the guest's words across host speech, and the message says who spoke in between and what they said.
function diagnoseHostJoin(segWords, vttWordStream) {
  var stripped = [], orig = [];
  for (var i = 0; i < vttWordStream.length; i++) {
    if (vttWordStream[i].charAt(0) === VTT_HOST_MARK) continue;
    stripped.push(vttWordStream[i]);
    orig.push(i);
  }
  var r = matchSegment(segWords, stripped, 0);
  if (!r.ok) return null;
  var said = [];
  for (var k = orig[r.start]; k <= orig[r.end - 1]; k++) {
    if (vttWordStream[k].charAt(0) === VTT_HOST_MARK) said.push(vttWordStream[k].slice(1));
  }
  if (!said.length) return null;
  return 'Guest words are joined across host speech with no \u201C\u2026\u201D (editorial rule 8):\n' +
    '      Answer has:   \u201C' + segWords.slice(0, 9).join(' ') + (segWords.length > 9 ? ' \u2026' : '') + '\u201D\n' +
    '      In between:   ' + said.map(function(s) { return '\u201C' + s + '\u201D'; }).join(' then ') + '\n' +
    '      Mark the join with \u201C\u2026\u201D, show the host\u2019s words with the answer and add the \u201CEllipsis added\u201D tag.';
}

function strictVerbatimCheck(pageTexts, vttWordStream) {
  if (!vttWordStream || vttWordStream.length < 3) {
    return ['Transcript extract is empty \u2014 check the data-vtt-speaker attribute and time range on this article.'];
  }
  var errors = [];
  for (var ti = 0; ti < pageTexts.length; ti++) {
    var pageText = pageTexts[ti];
    var segments = pageText.split(/\u2026|\.\.\./).map(function(s) { return s.trim(); });
    var vIdx = 0;
    for (var si = 0; si < segments.length; si++) {
      var segWords = normalizeSegment(segments[si]);
      if (segWords.length === 0) continue;
      var result = matchSegment(segWords, vttWordStream, vIdx);
      if (!result.ok) {
        var hostJoinMsg = diagnoseHostJoin(segWords, vttWordStream);
        if (hostJoinMsg) { errors.push(hostJoinMsg); break; }
        var answerSnippet = segWords.slice(0, 7).join(' ') + (segWords.length > 7 ? ' \u2026' : '');
        var vttSnippet    = vttWordStream
          .slice(Math.max(0, vIdx - 2), vIdx + 14)
          .map(normVttWord)
          .filter(function(w) { return w.length > 0; })
          .join(' ');
        var segInfo = segments.length > 1
          ? ' (part ' + (si + 1) + ' of ' + segments.length + ')'
          : '';
        errors.push(
          'Words not found in transcript' + segInfo + ':\n' +
          '      Answer has:             \u201C' + answerSnippet + '\u201D\n' +
          '      Transcript at that point: \u201C' + (vttSnippet || '(nothing \u2014 answer may run past the end of the time window)') + '\u201D\n' +
          '      If words were cut, mark the gap with \u201C\u2026\u201D (ellipsis). Never reword the speaker.'
        );
        break; // stop at first failure per text block
      }
      vIdx = result.end;
      // Ellipsis gaps may contain ANY VTT words — that is the point of the marker.
    }
    if (errors.length > 0) break;
  }
  return errors;
}

var EPISODE_SPEAKERS = {
  'b2b-podcast-agency-for-ai-visibility':         ['Casey Cheshire', 'Adam Needles'],
  'agency-to-get-my-brand-cited-by-chatgpt':      ['Simon Wilhelm', 'Casey Cheshire'],
};

var EP002_EXCLUDED = [
  { startMs: 29*60000+43000, endMs: 30*60000+32000 },
  { startMs: 35*60000+15000, endMs: 35*60000+55000 }
];

function isExcluded(startMs, endMs, excluded) {
  for (var i = 0; i < excluded.length; i++) {
    if (startMs < excluded[i].endMs && endMs > excluded[i].startMs) return true;
  }
  return false;
}

function parseVttStrict(content, speakers) {
  var cues = [];
  var text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
  var blocks = text.split(/\n\n+/);
  var lastSpeaker = '';
  for (var bi = 0; bi < blocks.length; bi++) {
    var block = blocks[bi];
    var lines = block.trim().split('\n');
    var tLine = null;
    for (var li = 0; li < lines.length; li++) {
      if (/\d+:\d+.*-->/.test(lines[li])) { tLine = lines[li]; break; }
    }
    if (!tLine) continue;
    var arrowIdx = tLine.indexOf('-->');
    var startMs  = _toMs(tLine.slice(0, arrowIdx));
    var endMs    = _toMs(tLine.slice(arrowIdx + 3));
    var tIdx     = lines.indexOf(tLine);
    var textLines = lines.slice(tIdx + 1).filter(function(l) { return l.trim(); });
    if (!textLines.length) continue;
    var speaker = '', cueText = '';
    var vm = textLines[0].match(/^<v ([^>]+)>/);
    if (vm) {
      speaker = vm[1]; lastSpeaker = speaker;
      cueText = textLines.map(function(l) {
        return l.replace(/^<v [^>]+>/, '').replace(/<\/v>/, '').trim();
      }).join(' ');
    } else {
      var cm = textLines[0].match(/^([A-Za-z][^:]{1,30}):\s(.+)/);
      if (cm) {
        speaker = cm[1]; lastSpeaker = speaker;
        cueText = cm[2] + (textLines.length > 1 ? ' ' + textLines.slice(1).join(' ') : '');
      } else {
        speaker = lastSpeaker;
        cueText = textLines.join(' ');
      }
    }
    cueText = cueText.trim();
    if (cueText) cues.push({ startMs: startMs, endMs: endMs, speaker: speaker, text: cueText });
  }
  return cues;
}

function _toMs(ts) {
  var clean = ts.trim().split(' ')[0];
  var parts = clean.split(':');
  if (parts.length === 3) {
    return (parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2])) * 1000;
  }
  return (parseInt(parts[0], 10) * 60 + parseFloat(parts[1])) * 1000;
}

var vttCache = {};
function getVttCues(slug, answersDir, speakers) {
  if (vttCache[slug]) return vttCache[slug];
  var vttPath = path.join(answersDir, slug, 'transcript.vtt');
  if (!fs.existsSync(vttPath)) return [];
  var content = fs.readFileSync(vttPath, 'utf8');
  vttCache[slug] = parseVttStrict(content, speakers);
  return vttCache[slug];
}

function verbatimCheckAnswerPages() {
  var answersDir = path.join(OUT, 'answers');
  if (!fs.existsSync(answersDir)) return;

  var pagesFailed = 0;
  var slugs = fs.readdirSync(answersDir).filter(function(d) {
    return fs.statSync(path.join(answersDir, d)).isDirectory();
  });

  var anyFailed = false;

  for (var si = 0; si < slugs.length; si++) {
    var slug     = slugs[si];
    var speakers = EPISODE_SPEAKERS[slug];
    if (!speakers) continue; // no VTT mapping yet (e.g. future episodes)

    var file = path.join(answersDir, slug, 'index.html');
    if (!fs.existsSync(file)) continue;
    var html     = fs.readFileSync(file, 'utf8');
    var excluded = slug === 'agency-to-get-my-brand-cited-by-chatgpt' ? EP002_EXCLUDED : [];

    // Match articles with data-vtt-* attributes
    var blockRe = /<article[^>]+data-vtt-speaker="([^"]+)"[^>]+data-vtt-start="([^"]+)"[^>]+data-vtt-end="([^"]+)"[^>]*>/g;
    var hasAttrs = blockRe.test(html);

    if (!hasAttrs) {
      console.warn(
        '  \u26a0 ' + slug + ': verbatim check skipped \u2014 ' +
        'add data-vtt-speaker, data-vtt-start, and data-vtt-end to every qa-item article.'
      );
      continue;
    }

    // Reset and iterate over article blocks
    blockRe = /<article[^>]+data-vtt-speaker="([^"]+)"[^>]+data-vtt-start="([^"]+)"[^>]+data-vtt-end="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g;
    var bm;
    while ((bm = blockRe.exec(html)) !== null) {
      var speaker   = bm[1];
      var startMs   = parseInt(bm[2], 10);
      var endMs     = parseInt(bm[3], 10);
      var blockHtml = bm[4];

      // Skip speaker-requested excluded ranges
      if (isExcluded(startMs, endMs, excluded)) continue;

      var isSynthesisBlock = blockHtml.indexOf('synthesis-source') >= 0 ||
                             blockHtml.indexOf('answer-label--synthesis') >= 0;

      var quoteTexts = extractQuoteTexts(blockHtml, isSynthesisBlock);
      if (!quoteTexts.length) continue;

      var cues         = getVttCues(slug, answersDir, speakers);
      if (!cues.length) continue;
      var openTag = (bm[0].match(/^<article[^>]*>/) || [''])[0];
      var ctM = openTag.match(/data-crosstalk="([^"]*)"/);
      var vttWordStream = buildVttWordStream(cues, startMs, endMs, speaker, pgParseCrosstalk(ctM ? ctM[1] : ''));

      var errs = strictVerbatimCheck(quoteTexts, vttWordStream);
      if (errs.length > 0) {
        var qIdMatch  = bm[0].match(/id="(q\d+)"/);
        var qId       = qIdMatch ? qIdMatch[1] : '?';
        var qText     = extractQuestionText(blockHtml);
        var qLabel    = qText
          ? (qId.toUpperCase() + ' \u2014 \u201C' + qText + '\u201D')
          : qId;

        if (!anyFailed) {
          console.error('\n\u2717 VERBATIM CHECK \u2014 answers that don\'t match the transcript:\n');
          anyFailed = true;
        }
        pagesFailed++;
        console.error('  Page: ' + slug);
        console.error('  ' + qLabel);
        errs.forEach(function(e) {
          // Each error line may be multi-line; indent sub-lines
          e.split('\n').forEach(function(line, idx) {
            console.error(idx === 0 ? '  \u2022 ' + line : '    ' + line);
          });
        });
        console.error('');

        // Machine-readable report entry
        reportError('verbatim', slug, qId, qText, errs.join(' | '));
      }
    }
  }

  if (anyFailed) {
    console.error(
      pagesFailed + ' answer' + (pagesFailed === 1 ? '' : 's') + ' need' +
      (pagesFailed === 1 ? 's' : '') + ' fixing. Pages that passed this check are unaffected.'
    );
    writeReport();
    process.exit(1);
  }
  console.log('Verbatim check passed (' + slugs.length + ' episode' + (slugs.length === 1 ? '' : 's') + ').');
}


// ── Markdown presence check ───────────────────────────────────────────────────
// Fails the build if any .html in dist/ is missing its pre-generated .md
// counterpart, or if the .md file does not start with YAML frontmatter (---).

function checkMarkdownPresence() {
  var missing = [];
  var broken  = [];

  function walk(dir) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || !e.name.endsWith('.html')) continue;
      var mdPath = p.slice(0, -5) + '.md';
      if (!fs.existsSync(mdPath)) {
        missing.push(path.relative(OUT, p));
      } else {
        var first = fs.readFileSync(mdPath, 'utf8').slice(0, 3);
        if (first !== '---') broken.push(path.relative(OUT, mdPath));
      }
    }
  }

  walk(OUT);

  if (missing.length > 0) {
    console.error('\n\u2717 MARKDOWN MISSING \u2014 re-run the build or check scripts/generate-markdown.js:');
    missing.forEach(function(f) {
      var msg = f + ' has no .md companion file';
      console.error('  \u2022 ' + msg);
      reportError('markdown', f, null, null, msg);
    });
    writeReport();
    process.exit(1);
  }
  if (broken.length > 0) {
    console.error('\n\u2717 MARKDOWN BROKEN \u2014 .md file is missing its YAML frontmatter (---):');
    broken.forEach(function(f) {
      var msg = f + ' exists but does not start with ---';
      console.error('  \u2022 ' + msg);
      reportError('markdown', f, null, null, msg);
    });
    writeReport();
    process.exit(1);
  }
  console.log('Markdown presence check passed.');
}

// ── Consistency gates (added Oct 28, 2026) ──────────────────────────────────────
// After an outside review found the homepage saying "0 answers", links to retired "best-" addresses,
// a hand-made schema excerpt and speaker-intro links with the wrong times, llms.txt calling a guest
// the host, and a table of contents that disagreed with its own headings. Each class now fails the
// build, with a plain-English message, if it ever comes back:
//
//   answer-count       every "N answers" / "N more answers" badge (homepage, answers index) matches the
//                      number of answers on the page it links to; a badge never points at a missing page
//   canonical-links    no internal link on a served page, in llms.txt or llms-full.txt hits a redirect
//                      in _redirects; links to /answers/, /episodes/, /speakers/ resolve to a real page
//   schema-copy        the visible "Structured data" copy on an answer page is exactly the head JSON-LD
//   intro-time         every speaker-intro play link: ?t= = the visible time = the aria-label time, and the
//                      quoted introduction is spoken at that time in the page's transcript.vtt (±3 s)
//   toc-heading        every table-of-contents entry is its answer's heading, word for word; the
//                      "slug#qN" label above each heading names the page's own address
//   anchor-text        every link to /answers/<slug>/#qN goes to an answer that exists and shows its heading
//   listing-title      in the homepage, answers, episodes and speakers indexes a link to an answer page
//                      shows that page's title (H1)
//   llms-roles         llms.txt names each episode's host(s) and guest(s) exactly as the page's credits do
//   no-js-placeholder  no served page shows "Loading…", sample-data or empty-state text to a reader
//                      that does not run JavaScript
//
// The Cited Episode Publish routine runs this same build.js before it pushes, and its site-wide
// consistency pass (lib/consistency.ts) writes the values these gates expect.

var CG_SITE = 'https://citedconversations.com';

function cgDecode(s) {
  var named = { hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', amp: '&',
                lt: '<', gt: '>', quot: '"', apos: "'", mdash: '\u2014', ndash: '\u2013', nbsp: ' ', middot: '\u00b7' };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function(m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(m, n) { return String.fromCodePoint(parseInt(n, 10)); })
    .replace(/&([a-z]+);/gi, function(m, n) { return named[n.toLowerCase()] !== undefined ? named[n.toLowerCase()] : m; });
}
function cgText(html) { return cgDecode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function cgClock(sec) { return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2); }

function cgFail(check, page, qId, msg) {
  console.error('\u2717 ' + check.toUpperCase() + (page ? ' (' + page + ')' : '') + (qId ? ' ' + qId.toUpperCase() : '') + ': ' + msg);
  reportError(check, page, qId, null, msg);
}

function cgRules() {
  var p = path.join(ROOT, '_redirects');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map(function(l) { return l.trim(); })
    .filter(function(l) { return l && l.charAt(0) !== '#'; })
    .map(function(l) { var x = l.split(/\s+/); return { from: x[0], to: x[1] }; })
    .filter(function(r) { return r.from && r.to && r.from.charAt(0) === '/'; });
}
function cgRedirect(rules, p) {
  for (var i = 0; i < rules.length; i++) {
    var f = rules[i].from;
    if (f.indexOf('*') === -1) { if (f === p) return rules[i].to; continue; }
    var re = new RegExp('^' + f.split('*').map(function(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }).join('.*') + '$');
    if (re.test(p)) return rules[i].to;
  }
  return null;
}
function cgWalk(dir, out) {
  fs.readdirSync(dir).forEach(function(n) {
    var p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) cgWalk(p, out); else out.push(p);
  });
  return out;
}
function cgRel(abs) { return path.relative(OUT, abs).split(path.sep).join('/'); }
function cgServed(rules, rel) {
  var url = '/' + rel.replace(/index\.html$/, '');
  return cgRedirect(rules, url) === null && cgRedirect(rules, '/' + rel) === null;
}
function cgExists(p) {
  var clean = p.split('#')[0].split('?')[0];
  var f = path.join(OUT, clean);
  if (clean.slice(-1) === '/') return fs.existsSync(path.join(f, 'index.html'));
  return fs.existsSync(f) || fs.existsSync(path.join(f, 'index.html'));
}

function cgAnswerPages() {
  var dir = path.join(OUT, 'answers');
  var pages = {};
  if (!fs.existsSync(dir)) return pages;
  fs.readdirSync(dir).forEach(function(slug) {
    var f = path.join(dir, slug, 'index.html');
    if (!fs.existsSync(f)) return;
    var html = fs.readFileSync(f, 'utf8');
    if (html.indexOf('class="qa-item"') === -1) return;
    var heads = {}, ids = [], m, re = /<article class="qa-item" id="(q\d+)"[^>]*>([\s\S]*?)<\/article>/g;
    while ((m = re.exec(html)) !== null) {
      ids.push(m[1]);
      var h3 = m[2].match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
      heads[m[1]] = h3 ? cgText(h3[1]) : '';
    }
    var h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    var num = html.match(/"episodeNumber"\s*:\s*(\d+)/);
    pages[slug] = { slug: slug, html: html, heads: heads, ids: ids, count: (html.match(/class="qa-item"/g) || []).length,
                    title: h1 ? cgText(h1[1]) : '', number: num ? parseInt(num[1], 10) : null };
  });
  return pages;
}

// Credits line on an answer page -> { hosts: [names], guests: [names] }
function cgCredits(html) {
  var sec = html.match(/<section id="credits"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
  var out = { hosts: [], guests: [] };
  if (!sec) return out;
  var parts = sec[1].split(/<strong>/).slice(1);
  parts.forEach(function(part) {
    var lab = part.match(/^([^<]*)<\/strong>([\s\S]*)$/);
    if (!lab) return;
    var label = lab[1], body = cgText(lab[2]);
    var names = body.split(/;\s*/).map(function(x) { return x.split(',')[0].trim(); }).filter(Boolean);
    if (/host/i.test(label)) out.hosts = out.hosts.concat(names);
    else if (/guest/i.test(label)) out.guests = out.guests.concat(names);
  });
  return out;
}

function consistencyGates() {
  var rules = cgRules();
  var pages = cgAnswerPages();
  var all = cgWalk(OUT, []);
  var htmlFiles = all.filter(function(f) { return /\.html$/.test(f); }).map(cgRel)
    .filter(function(r) { return cgServed(rules, r) && !/(^|\/)_template\.html$/.test(r); });
  var before = REPORT.errors.length;

  // answer-count
  ['index.html', 'answers/index.html'].forEach(function(rel) {
    var f = path.join(OUT, rel);
    if (!fs.existsSync(f)) return;
    var html = fs.readFileSync(f, 'utf8');
    var m, re = /<span[^>]*data-answer-slug="([^"]*)"[^>]*>(\d+) answers<\/span>/g;
    while ((m = re.exec(html)) !== null) {
      var pg = pages[m[1]];
      if (!pg) cgFail('answer-count', rel, null, 'an answer-count badge names "' + m[1] + '", which is not an answer page in answers/, so it would show the wrong number. Use the page\'s current address.');
      else if (parseInt(m[2], 10) !== pg.count) cgFail('answer-count', rel, null, 'the badge for ' + m[1] + ' says ' + m[2] + ' answers but the page has ' + pg.count + '.');
    }
    html.split(/(?=<div class="conversation-row")/).forEach(function(row) {
      if (row.indexOf('<div class="conversation-row"') !== 0) return;
      var s = (row.match(/href="\/answers\/([a-z0-9-]+)\/"/) || [])[1];
      var pg = s ? pages[s] : null;
      if (!s) { cgFail('answer-count', rel, null, 'a conversation row does not link to an answer page at its current address.'); return; }
      if (!pg) { cgFail('answer-count', rel, null, 'a conversation row links to /answers/' + s + '/, which is not an answer page.'); return; }
      var more = row.match(/>(\d+) more answers<\/span>/), tot = row.match(/>(\d+) answers<\/span>/);
      if (more && parseInt(more[1], 10) !== pg.count - 1) cgFail('answer-count', rel, null, 'the row for ' + s + ' says "' + more[1] + ' more answers" but the page has ' + pg.count + ' answers (so ' + (pg.count - 1) + ' more).');
      if (tot && parseInt(tot[1], 10) !== pg.count) cgFail('answer-count', rel, null, 'the row for ' + s + ' says ' + tot[1] + ' answers but the page has ' + pg.count + '.');
    });
  });

  // canonical-links
  function checkLink(rel, p) {
    var clean = p.split('#')[0].split('?')[0];
    var t = cgRedirect(rules, clean);
    if (t !== null) { cgFail('canonical-links', rel, null, 'links to ' + clean + ', which redirects to ' + t + '. Link straight to ' + t + '.'); return; }
    if (/^\/(answers|episodes|speakers)\//.test(clean) && !cgExists(clean)) cgFail('canonical-links', rel, null, 'links to ' + clean + ', which is not a page on the site.');
  }
  htmlFiles.forEach(function(rel) {
    var html = fs.readFileSync(path.join(OUT, rel), 'utf8');
    var m, re = /(?:href|src)="(?:https:\/\/citedconversations\.com)?(\/[^"\s]*)"/g, seen = {};
    while ((m = re.exec(html)) !== null) { var k = m[1].split('#')[0].split('?')[0]; if (!seen[k]) { seen[k] = 1; checkLink(rel, m[1]); } }
  });
  ['llms.txt', 'llms-full.txt'].forEach(function(rel) {
    var f = path.join(OUT, rel);
    if (!fs.existsSync(f)) return;
    var txt = fs.readFileSync(f, 'utf8'), m, re = /https:\/\/citedconversations\.com(\/[^\s)\]"'>]*)/g, seen = {};
    while ((m = re.exec(txt)) !== null) { if (!seen[m[1]]) { seen[m[1]] = 1; checkLink(rel, m[1]); } }
  });

  Object.keys(pages).forEach(function(slug) {
    var pg = pages[slug], html = pg.html, rel = 'answers/' + slug + '/index.html';

    // schema-copy
    var d = html.search(/(<summary[^>]*>|class="section-label">|aria-label=")Structured data/);
    if (d >= 0) {
      var ps = html.indexOf('<pre', d), pe = html.indexOf('</pre>', d);
      var head = null, shown = null;
      try { head = JSON.parse(getJsonLdBlock(html)); } catch (e) { head = null; }
      if (ps >= 0 && pe > ps) {
        var inner = html.slice(html.indexOf('>', ps) + 1, pe).replace(/^<code>/, '').replace(/<\/code>$/, '');
        try { shown = JSON.parse(cgDecode(inner)); } catch (e) { shown = null; }
      }
      if (!head) cgFail('schema-copy', slug, null, 'the head JSON-LD does not parse.');
      else if (!shown) cgFail('schema-copy', slug, null, 'the visible "Structured data" copy is not valid JSON-LD (a hand-made excerpt?). It must be the head JSON-LD itself.');
      else if (JSON.stringify(shown) !== JSON.stringify(head)) {
        var clipsShown = (shown['@graph'] || []).filter(function(n) { return n['@type'] === 'Clip'; });
        var firstBad = clipsShown.filter(function(c) {
          var h = (head['@graph'] || []).filter(function(n) { return n['@id'] === c['@id']; })[0];
          return !h || h.startOffset !== c.startOffset || h.endOffset !== c.endOffset || h.url !== c.url;
        })[0];
        cgFail('schema-copy', slug, null, 'the visible "Structured data" copy differs from the head JSON-LD' +
          (firstBad ? ' (e.g. Clip ' + (firstBad['@id'] || firstBad.name) + ' shows ' + firstBad.startOffset + '\u2013' + firstBad.endOffset + ' ' + firstBad.url + ')' : '') + '. It must be the head JSON-LD itself.');
      }
    }

    // intro-time
    var prov = html.match(/<section[^>]*id="provenance"[\s\S]*?<\/section>/);
    if (prov) {
      var vttF = path.join(OUT, 'answers', slug, 'transcript.vtt');
      var cues = fs.existsSync(vttF) ? pgParseVtt(fs.readFileSync(vttF, 'utf8')) : [];
      var flat = [];
      cues.forEach(function(c) {
        var t = c.t.replace(/^[A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,3}:\s/, '');
        pgNorm(t.replace(/[\u2018\u2019']/g, '')).forEach(function(w) { flat.push({ w: w, s: c.s, e: c.e }); });
      });
      var cards = prov[0].split(/(?=<blockquote)/).slice(1);
      cards.forEach(function(card) {
        var bq = card.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
        var ln = card.match(/<a href="([^"]*)"[^>]*class="citation-ts"[^>]*aria-label="([^"]*)"[^>]*>([^<]*)<\/a>/);
        if (!bq || !ln) return;
        var who = cgText(ln[2]).replace(/^Hear\s+/, '').replace(/\s+at\s+.*$/, '');
        var tq = ln[1].match(/[?&]t=(\d+)/);
        var vis = cgText(ln[3]).match(/(\d+):(\d\d)/), aria = cgText(ln[2]).match(/(\d+):(\d\d)/);
        if (!tq) { cgFail('intro-time', slug, null, who + ': the intro play link has no ?t= time.'); return; }
        var t = parseInt(tq[1], 10);
        var vs = vis ? parseInt(vis[1], 10) * 60 + parseInt(vis[2], 10) : null, as = aria ? parseInt(aria[1], 10) * 60 + parseInt(aria[2], 10) : null;
        if (vs !== t || as !== t) cgFail('intro-time', slug, null, who + ': the intro link goes to ?t=' + t + ' (' + cgClock(t) + ') but shows ' + (vis ? vis[0] : 'no time') + ' and its label says ' + (aria ? aria[0] : 'no time') + '. All three must be the same moment.');
        var q = pgNorm(cgText(bq[1]).replace(/[\u201c\u201d"]/g, ' ').replace(/[\u2018\u2019']/g, '')).slice(0, 5);
        var at = null;
        for (var i = 0; q.length >= 3 && i + q.length <= flat.length; i++) {
          var ok = true;
          for (var k = 0; k < q.length; k++) if (flat[i + k].w !== q[k]) { ok = false; break; }
          if (ok) { at = flat[i]; break; }
        }
        if (!at) cgFail('intro-time', slug, null, who + ': the quoted introduction ("' + q.join(' ') + ' \u2026") is not in transcript.vtt, so its time cannot be checked.');
        else if (t < Math.floor(at.s) - 3 || t > Math.ceil(at.e) + 3) cgFail('intro-time', slug, null, who + ': the intro link goes to ' + cgClock(t) + ' but the quoted introduction is spoken at ' + cgClock(Math.floor(at.s)) + ' in transcript.vtt.');
      });
    }

    // toc-heading
    var toc = html.match(/<section id="toc"[\s\S]*?<\/section>/);
    if (toc) {
      var m, re = /<a href="#(q\d+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((m = re.exec(toc[0])) !== null) {
        var txt = cgText(m[2]).replace(/^#q\d+\s*\u2014\s*/, '');
        if (pg.heads[m[1]] === undefined) continue; // integrity gate reports a missing anchor
        if (txt !== pg.heads[m[1]]) cgFail('toc-heading', slug, m[1], 'the table of contents says "' + txt + '" but the answer\'s heading is "' + pg.heads[m[1]] + '". They must be the same words.');
      }
    }
    var lm, lre = /<article class="qa-item" id="(q\d+)"[^>]*>\s*<p style="font-family: var\(--font-mono\);[^"]*">([^<]*)<\/p>/g;
    while ((lm = lre.exec(html)) !== null) {
      if (lm[2] !== slug + '#' + lm[1]) cgFail('toc-heading', slug, lm[1], 'the label above the heading says "' + lm[2] + '" but this answer\'s address is ' + slug + '#' + lm[1] + '.');
    }
  });

  // anchor-text + listing-title
  var LISTINGS = { 'index.html': 1, 'answers/index.html': 1, 'episodes/index.html': 1, 'speakers/index.html': 1 };
  htmlFiles.forEach(function(rel) {
    if (/^answers\/[^/]+\/index\.html$/.test(rel) && pages[rel.split('/')[1]]) return;
    var html = fs.readFileSync(path.join(OUT, rel), 'utf8');
    var m, re = /<a href="(?:https:\/\/citedconversations\.com)?\/answers\/([a-z0-9-]+)\/#(q\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re.exec(html)) !== null) {
      var pg = pages[m[1]];
      if (!pg) continue; // canonical-links reports it
      var txt = cgText(m[3]);
      if (pg.heads[m[2]] === undefined) { cgFail('anchor-text', rel, m[2], 'links to /answers/' + m[1] + '/#' + m[2] + ', but that page has no answer ' + m[2] + '.'); continue; }
      if (/^(#?q\d+|\u25b6.*|listen.*|view.*)$/i.test(txt)) continue;
      if (txt !== pg.heads[m[2]]) cgFail('anchor-text', rel, m[2], 'the link to ' + m[1] + '#' + m[2] + ' says "' + txt + '" but that answer\'s heading is "' + pg.heads[m[2]] + '".');
    }
    if (!LISTINGS[rel]) return;
    var tm, tre = /<a href="\/answers\/([a-z0-9-]+)\/"[^>]*>([\s\S]*?)<\/a>/g;
    while ((tm = tre.exec(html)) !== null) {
      var p2 = pages[tm[1]];
      if (!p2 || /<[a-z]/i.test(tm[2])) continue;
      if (cgText(tm[2]) !== p2.title) cgFail('listing-title', rel, null, 'the link to /answers/' + tm[1] + '/ says "' + cgText(tm[2]) + '" but that page\'s title is "' + p2.title + '".');
    }
  });

  // llms-roles
  var llmsF = path.join(OUT, 'llms.txt');
  if (fs.existsSync(llmsF)) {
    var llms = fs.readFileSync(llmsF, 'utf8');
    var pad = function(n) { return ('00' + n).slice(-3); };
    Object.keys(pages).forEach(function(slug) {
      var pg = pages[slug], cr = cgCredits(pg.html), url = CG_SITE + '/answers/' + slug + '/';
      if (!cr.hosts.length && !cr.guests.length) return;
      var ep = pg.number !== null ? 'Episode ' + pad(pg.number) : null;
      var epLines = llms.split('\n').filter(function(l) { return ep && l.indexOf('[' + ep + ' ') !== -1; }); // split-aware (cited-episode-publish)
      var line = (epLines.filter(function(l) { return l.indexOf('](' + url + ')') !== -1; })[0]) || epLines[0] || '';
      if (!line) { cgFail('llms-roles', 'llms.txt', null, (ep || slug) + ' has no line in the Episodes section of llms.txt.'); return; }
      if (line.indexOf('](' + url + ')') === -1) cgFail('llms-roles', 'llms.txt', null, ep + ' should link to ' + url + '.');
      if (/Guests?:/.test(line) && !/Guest expert/.test(line)) cgFail('llms-roles', 'llms.txt', null, ep + ' lists everyone as "Guests"; the page credits ' + cr.hosts.join(', ') + ' as host.');
      var gi = line.search(/Guest experts?: /), hi = line.search(/Hosts?: /);
      var hostPart = hi >= 0 ? line.slice(hi, gi > hi ? gi : line.length) : '';
      var guestPart = gi >= 0 ? line.slice(gi, hi > gi ? hi : line.length) : '';
      cr.hosts.forEach(function(h) {
        if (hostPart.indexOf(h) === -1 || guestPart.indexOf(h) !== -1) cgFail('llms-roles', 'llms.txt', null, ep + ': the page credits ' + h + ' as host, but llms.txt does not say so.');
      });
      cr.guests.forEach(function(g) {
        if (guestPart.indexOf(g) === -1 || hostPart.indexOf(g) !== -1) cgFail('llms-roles', 'llms.txt', null, ep + ': the page credits ' + g + ' as the guest expert, but llms.txt does not say so.');
      });
      var spkLines = llms.split('\n').filter(function(l) { return /^- \[[^\]]+\]\(https:\/\/citedconversations\.com\/speakers\//.test(l); });
      spkLines.forEach(function(l) {
        var name = l.match(/^- \[([^\]]+)\]/)[1];
        var isHost = cr.hosts.indexOf(name) !== -1, isGuest = cr.guests.indexOf(name) !== -1;
        if (!ep || (!isHost && !isGuest)) return;
        var epT = Object.keys(pages).filter(function(s) { return pages[s].number === pg.number; }).length > 1 ? ep + ' ("' + pg.title + '")' : ep; // split episode: role per page (cited-episode-publish)
        var want = isHost ? 'host of ' + epT : 'guest expert in ' + epT;
        var wrong = isHost ? 'guest expert in ' + epT : 'host of ' + epT;
        if (l.toLowerCase().indexOf(want.toLowerCase()) === -1 || l.toLowerCase().indexOf(wrong.toLowerCase()) !== -1 || /host[^;.]*both/i.test(l))
          cgFail('llms-roles', 'llms.txt', null, name + '\'s line must say "' + want + '" (from the page credits).');
      });
    });
  }

  // no-js-placeholder
  htmlFiles.forEach(function(rel) {
    var html = fs.readFileSync(path.join(OUT, rel), 'utf8');
    var body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
    var hits = [];
    if (/Loading(\u2026|\.\.\.|&hellip;|&#8230;)/.test(body)) hits.push('"Loading\u2026"');
    if (/Sample data/i.test(body)) hits.push('"Sample data"');
    if (/No crawler activity (recorded )?yet/i.test(body)) hits.push('"No crawler activity yet"');
    if (/id="kpi-[a-z-]+"[^>]*>\s*(\u2014|&mdash;|&#8212;)\s*</.test(body)) hits.push('an empty "\u2014" statistic');
    if (/Last updated: (\u2014|&mdash;)/.test(body)) hits.push('"Last updated: \u2014"');
    if (hits.length) cgFail('no-js-placeholder', rel, null, 'without JavaScript the page shows ' + hits.join(', ') + '. Most AI crawlers don\'t run JavaScript, so the static HTML must carry the real content.');
  });

  var found = REPORT.errors.length - before;
  if (found > 0) {
    console.error('\n\u2717 CONSISTENCY GATES \u2014 ' + found + ' problem' + (found === 1 ? '' : 's') + ' (see above). Nothing was deployed; the live site stays on the last good build.');
    writeReport();
    process.exit(1);
  }
  console.log('Consistency gates passed (' + Object.keys(pages).length + ' answer pages, ' + htmlFiles.length + ' served pages).');
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Building dist/ ...');
copy(ROOT, OUT);

console.log('Post-processing: patching /about/ links ...');
patchAboutLinks(OUT);

console.log('Post-processing: injecting answer counts ...');
patchHomepageCounts();

console.log('Post-processing: rendering the stats page from data/bot-traffic.json ...');
patchStatsDates();

console.log('Integrity check: validating answer pages ...');
integrityCheckAnswerPages();

console.log('Passage gates: timing, labels, schema text, clip count ...');
passageGates();

console.log('Changelog check: validating changelog entries ...');
changelogCheck();

console.log('Verbatim check: validating quoted text against transcript ...');
verbatimCheckAnswerPages();

console.log('Markdown: generating .md files for every page ...');
generateMarkdown.generateMarkdownVersions(OUT);

console.log('Markdown: verifying .md presence and format ...');
checkMarkdownPresence();

console.log('Encoding check: scanning served text files for garbled characters ...');
encodingCheck();

console.log('Consistency gates: counts, canonical links, schema copy, intro times, TOC, link texts, llms roles, no-JS placeholders ...');
consistencyGates();

console.log('Sitemap gate: checking the sitemap index, child sitemaps and feed ...');
if (require('./scripts/sitemap-gate').run(ROOT, OUT, reportError, reportWarning, console) > 0) {
  console.error('\n\u2717 SITEMAP GATE \u2014 see dist/build-report.json.');
  writeReport();
  process.exit(1);
}

// Write a "passed" report so the downstream process knows everything is green.
writeReport();
console.log('Build complete.');
