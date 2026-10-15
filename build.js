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
  errors: []
};

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

    // Check: article count must match Clip count
    if (clipCount > 0 && articleCount !== clipCount) {
      var msg = articleCount + ' answer' + (articleCount === 1 ? '' : 's') + ' rendered but ' +
                clipCount + ' JSON-LD Clip node' + (clipCount === 1 ? '' : 's') +
                ' — they must match. The schema may be out of sync with the page content.';
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
  'best-b2b-podcast-agency-for-ai-visibility':         ['Casey Cheshire', 'Adam Needles'],
  'best-agency-to-get-my-brand-cited-by-chatgpt':      ['Simon Wilhelm', 'Casey Cheshire'],
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
    var excluded = slug === 'best-agency-to-get-my-brand-cited-by-chatgpt' ? EP002_EXCLUDED : [];

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
        var qIdMatch  = blockHtml.match(/id="(q\d+)"/);
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

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Building dist/ ...');
copy(ROOT, OUT);

console.log('Post-processing: patching /about/ links ...');
patchAboutLinks(OUT);

console.log('Post-processing: injecting answer counts ...');
patchHomepageCounts();

console.log('Integrity check: validating answer pages ...');
integrityCheckAnswerPages();

console.log('Changelog check: validating changelog entries ...');
changelogCheck();

console.log('Verbatim check: validating quoted text against transcript ...');
verbatimCheckAnswerPages();

console.log('Markdown: generating .md files for every page ...');
generateMarkdown.generateMarkdownVersions(OUT);

console.log('Markdown: verifying .md presence and format ...');
checkMarkdownPresence();

// Write a "passed" report so the downstream process knows everything is green.
writeReport();
console.log('Build complete.');
