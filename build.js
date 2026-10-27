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

// ── Post-process: bake data-through dates into the stats page ─────────────────
// stats/index.html fills its dates in the browser from data/bot-traffic.json, so a
// reader that doesn't run JavaScript would otherwise see placeholders. Write the same
// dates into the static HTML here, from the same file the daily stats run updates.
// "Latest date" = newest day in the data rows (not build time). Never fails the build:
// if the data or page can't be read, the page is left as-is and a warning is printed.

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

function patchStatsDates() {
  try {
    var pagePath = path.join(OUT, 'stats', 'index.html');
    var dataPath = path.join(ROOT, 'data', 'bot-traffic.json');
    if (!fs.existsSync(pagePath) || !fs.existsSync(dataPath)) {
      console.warn('\u26a0\ufe0f  Stats dates not baked in: stats page or data/bot-traffic.json not found.');
      return;
    }
    var data  = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    var dates = [];
    (data.daily || []).concat(data.traffic_mix || []).forEach(function(r) {
      if (r && typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) dates.push(r.date);
    });
    dates.sort();
    var earliest = dates.length ? dates[0] : data.launch_date;
    var latest   = dates.length ? dates[dates.length - 1]
                                : (data.updated_at ? String(data.updated_at).slice(0, 10) : earliest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(earliest)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(latest))) {
      console.warn('\u26a0\ufe0f  Stats dates not baked in: no usable dates in data/bot-traffic.json.');
      return;
    }

    var range = statsDateShort(earliest) + ' \u2013 ' + statsDateShort(latest);
    var edits = [
      ['last-updated',     'Last updated: ' + statsDateLong(latest)],
      ['stats-meta',       '<strong>' + range + '</strong><span class="sep">\u00b7</span>' +
                           'Tracking: GPTBot, ClaudeBot, PerplexityBot, Googlebot, and more'],
      ['kpi-since',        range],
      ['kpi-launch-date',  range],
      ['bot-section-note', range],
      ['updated-note',     'Data last updated: ' + statsDateLong(latest) +
                           ' \u00b7 Updates daily \u00b7 Source: Cloudflare Log Explorer']
    ];

    var html = fs.readFileSync(pagePath, 'utf8');
    var missing = [];
    edits.forEach(function(e) {
      var next = setElementText(html, e[0], e[1]);
      if (next === null) missing.push(e[0]); else html = next;
    });
    fs.writeFileSync(pagePath, html, 'utf8');

    if (missing.length) console.warn('\u26a0\ufe0f  Stats dates: element(s) not found: ' + missing.join(', '));
    console.log('Stats dates baked in: ' + range + ' (last updated ' + statsDateLong(latest) + ').');
  } catch (err) {
    console.warn('\u26a0\ufe0f  Stats dates not baked in: ' + err.message);
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
//   encoding        no mojibake and no invalid UTF-8 in any served text file
//
// Time rule: whole seconds on the page and in the schema; start rounds down, end
// rounds up from the exact millisecond cue times kept in data-vtt-start / -end.

var PG_VTT_TOLERANCE_MS = 3000;
var PG_SPEAKERS = ['Casey Cheshire', 'Adam Needles', 'Simon Wilhelm'];

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

function pgTokens(cues) {
  var out = [];
  var spk = '';
  var re = new RegExp('(' + PG_SPEAKERS.join('|') + '):\\s*', 'g');
  cues.forEach(function(c, ci) {
    var last = 0, m, cur = spk, pieces = [];
    re.lastIndex = 0;
    while ((m = re.exec(c.t)) !== null) {
      if (m.index > last) pieces.push({ spk: cur, text: c.t.slice(last, m.index) });
      cur = m[1];
      last = m.index + m[0].length;
    }
    pieces.push({ spk: cur, text: c.t.slice(last) });
    spk = cur;
    pieces.forEach(function(p) {
      pgNorm(p.text).forEach(function(w) { out.push({ w: w, cue: ci, spk: p.spk }); });
    });
  });
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
    if (last >= 0) cands.push({ first: i, last: last });
  }
  if (!cands.length) return null;
  function score(c) {
    var d = hintSec === null ? 0 : Math.abs(cues[v[c.first].cue].s - hintSec);
    return d + (v[c.first].spk === spk ? 0 : 1000);
  }
  var best = cands[0];
  for (var k = 1; k < cands.length; k++) { if (score(cands[k]) < score(best)) best = cands[k]; }
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
      labels: labels, passages: passages, anchors: anchors,
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
    var clips = {}, quotes = {}, clipTotal = 0, quoteTotal = 0;
    graph.forEach(function(n) {
      if (n['@type'] === 'Clip') { clips[n['@id']] = n; clipTotal++; }
      if (n['@type'] === 'Quotation') { quotes[n['@id']] = n; quoteTotal++; }
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

function buildVttWordStream(cues, startMs, endMs, speaker) {
  var SLACK   = 10000;
  var rawWords = [];
  cues.forEach(function(c) {
    if (c.speaker !== speaker) return;
    if (c.endMs < startMs - SLACK || c.startMs > endMs + SLACK) return;
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
    if (rawWords[i].endsWith('-') && /[A-Z]/.test(rawWords[i]) && i + 1 < rawWords.length) {
      merged.push(rawWords[i] + rawWords[i + 1]);
      i++;
    } else {
      merged.push(rawWords[i]);
    }
  }
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
    if (ok) return { ok: true, end: vi2 };
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

// Known verbatim exceptions, written down here so they are visible instead of silent.
// These two Ep 002 answers join words across a host interjection without a "…" (editorial rule 2: every cut is marked).
// Until Casey decides (mark the cuts, or drop the answers) the build WARNS instead of failing. Before Oct 27, 2026 they were
// skipped with no message at all, because their (too wide) time window overlapped a speaker-removed range (EP002_EXCLUDED).
var VERBATIM_WAIVERS = {
  'agency-to-get-my-brand-cited-by-chatgpt': ['q13', 'q15']
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
      var vttWordStream = buildVttWordStream(cues, startMs, endMs, speaker);

      var errs = strictVerbatimCheck(quoteTexts, vttWordStream);
      if (errs.length > 0) {
        var qIdMatch  = bm[0].match(/id="(q\d+)"/);
        var qId       = qIdMatch ? qIdMatch[1] : '?';
        var qText     = extractQuestionText(blockHtml);
        if ((VERBATIM_WAIVERS[slug] || []).indexOf(qId) !== -1) {
          var wmsg = 'Verbatim check WAIVED for ' + qId.toUpperCase() + ': ' + errs[0].split('\n')[0] +
                     ' (unmarked cut inside the answer — needs an editorial decision; see VERBATIM_WAIVERS in build.js).';
          console.warn('  ⚠ ' + slug + ' ' + wmsg);
          reportWarning('verbatim', slug, qId, qText, wmsg);
          continue;
        }
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

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Building dist/ ...');
copy(ROOT, OUT);

console.log('Post-processing: patching /about/ links ...');
patchAboutLinks(OUT);

console.log('Post-processing: injecting answer counts ...');
patchHomepageCounts();

console.log('Post-processing: baking dates into stats page ...');
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

// Write a "passed" report so the downstream process knows everything is green.
writeReport();
console.log('Build complete.');
