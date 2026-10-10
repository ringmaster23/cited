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
 */

var fs   = require('fs');
var path = require('path');

var ROOT    = __dirname;
var OUT     = path.join(ROOT, 'dist');
var EXCLUDE = {
  '.git':             true,
  'dist':             true,
  'functions':        true,
  'scripts':          true,
  'node_modules':     true,
  'build.js':         true,
  'wrangler.toml':    true,
  'package.json':     true,
  'package-lock.json':true,
};

// ── Copy ─────────────────────────────────────────────────────────────────────

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

// ── Post-process: /about/ → /methodology/ in all HTML ────────────────────────

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

// ── Post-process: inject real answer counts into homepage ─────────────────────
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

// ── Integrity check: answer pages must be internally consistent ───────────────
// Fails the build with details if any answer page has:
//   1. A TOC anchor link (#qN) with no matching id="qN" in the body
//   2. A different number of rendered articles vs TOC anchor links
//   3. A different number of rendered articles vs JSON-LD Clip nodes
//
// Counts Clips only inside the application/ld+json block to avoid false
// positives from prose text or body-level references.

function getJsonLdBlock(html) {
  var marker = '<script type="application/ld+json">';
  var start  = html.indexOf(marker);
  if (start === -1) return '';
  var end = html.indexOf('</script>', start);
  return end === -1 ? '' : html.slice(start + marker.length, end);
}

function integrityCheckAnswerPages() {
  var answersDir = path.join(OUT, 'answers');
  if (!fs.existsSync(answersDir)) return;

  var errors = [];
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

    // Collect all article ids (id="q1", id="q4", etc.) — articles only
    var articleIds = [];
    var idPattern = /id="(q\d+)"/g;
    var m;
    while ((m = idPattern.exec(html)) !== null) {
      articleIds.push(m[1]);
    }

    // Collect TOC anchor links (href="#q1", href="#q4", etc.)
    var tocAnchors = [];
    var tocPattern = /href="#(q\d+)"/g;
    while ((m = tocPattern.exec(html)) !== null) {
      tocAnchors.push(m[1]);
    }

    // Count Clip nodes in JSON-LD only
    var ldBlock   = getJsonLdBlock(html);
    var clipCount = (ldBlock.match(/"@type": "Clip"/g) || []).length;

    var pageErrors = [];

    // Check: every TOC anchor must have a matching article id
    for (var ti = 0; ti < tocAnchors.length; ti++) {
      if (articleIds.indexOf(tocAnchors[ti]) === -1) {
        pageErrors.push('TOC anchor #' + tocAnchors[ti] + ' has no matching id="' + tocAnchors[ti] + '" in the body');
      }
    }

    // Check: article count must match TOC count
    if (tocAnchors.length > 0 && articleCount !== tocAnchors.length) {
      pageErrors.push(articleCount + ' rendered articles but ' + tocAnchors.length + ' TOC links — must match');
    }

    // Check: article count must match Clip count
    if (clipCount > 0 && articleCount !== clipCount) {
      pageErrors.push(articleCount + ' rendered articles but ' + clipCount + ' JSON-LD Clip nodes — must match');
    }


    // Batch 4: required editorial fields for every answer page
    if (!html.includes('conversation-notice')) {
      pageErrors.push('Missing .conversation-notice top notice ("not an independent ranking" block)');
    }
    if (!html.includes('answer-label')) {
      pageErrors.push('Missing at least one .answer-label (verbatim/edited/synthesis transformation label)');
    }
    if (!html.includes('question headings are written by our editors')) {
      pageErrors.push('Missing label-line: "question headings are written by our editors"');
    }

    if (pageErrors.length > 0) {
      errors.push(slug + ':');
      for (var pi = 0; pi < pageErrors.length; pi++) {
        errors.push('  • ' + pageErrors[pi]);
      }
    }
  }

  if (errors.length > 0) {
    console.error('\n❌ INTEGRITY ERRORS — build aborted, fix these before shipping:');
    for (var ei = 0; ei < errors.length; ei++) {
      console.error(errors[ei]);
    }
    process.exit(1);
  }

  console.log('Integrity check passed (' + slugs.length + ' answer page' + (slugs.length === 1 ? '' : 's') + ').');
}


// ── Changelog check: dateModified must have a matching changelog entry ────────
// Reads data/changelog.json and warns if any answer page has a dateModified
// in its JSON-LD that is newer than the latest entry for that page in the log.

function changelogCheck() {
  var changelogPath = path.join(OUT, 'data', 'changelog.json');
  if (!fs.existsSync(changelogPath)) {
    console.warn('\u26a0\ufe0f  No data/changelog.json found — skipping changelog check.');
    return;
  }
  var log = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
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
    var html = fs.readFileSync(file, 'utf8');
    var dmMatch = html.match(/"dateModified":\s*"(\d{4}-\d{2}-\d{2})"/);
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
      warnings.push(slug + ': dateModified ' + dateModified + ' is newer than latest changelog entry ' + latest + ' — add a changelog entry for this change.');
    }
  }
  if (warnings.length) {
    console.warn('\n\u26a0\ufe0f  CHANGELOG WARNINGS — add entries to data/changelog.json:');
    warnings.forEach(function(w) { console.warn('   • ' + w); });
  } else {
    console.log('Changelog check passed (' + slugs.length + ' answer page' + (slugs.length === 1 ? '' : 's') + ').');
  }
}

// ── Strict verbatim check ─────────────────────────────────────────────────────
// Casey's rule 4: the build fails if ANY quoted text doesn't match the VTT
// apart from marked ellipses and brackets.
//
// Algorithm:
//   1. Split page quote on ellipsis (…) → segments
//   2. Strip [bracket] words from each segment (permitted additions)
//   3. Normalize both: lowercase, strip punctuation, split into words
//   4. For each segment, the word sequence must appear contiguously in VTT order
//      starting from where the previous segment ended
//   5. Between segments (the gap marked by …), only filler words are permitted
//      in the VTT (ums, false starts ≤4 chars, repeated adjacent words)
//   6. Fails on first mismatch; reports the offending words and context
//
// Ep 002: excluded ranges (speaker request)

// ── Strict verbatim check (v2) ────────────────────────────────────────────────
// Casey's rule 4: the build fails if ANY quoted text doesn't match the VTT
// apart from marked ellipses and brackets.
//
// Algorithm:
//   1. Split page quote on ellipsis (…) → segments
//   2. Strip [bracket] words from each segment (permitted additions)
//   3. Normalize both: lowercase, strip ALL punctuation (including hyphens)
//   4. For each segment, search the full VTT word stream for a contiguous match
//      starting from where the previous segment ended.
//   5. Ellipsis gaps may contain ANY VTT words (that is the point of the marker).
//   6. Fails on first mismatch; reports offending words and context.
//   For synthesis answers: checks synthesis-source-text paragraphs, not summary.

// Extended fillers: um/uh/er/ah/hmm + discourse markers + phrase repeats (2–4 back)
var VTT_STRICT_FILLER = new Set(['um','uh','er','ah','hmm','mm','mmhmm']);
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
  // Phrase repeats (2–4 back)
  if (p1 && n === normVttWord(p1)) return true;
  if (p2 && n === normVttWord(p2)) return true;
  if (p3 && n === normVttWord(p3)) return true;
  if (p4 && n === normVttWord(p4)) return true;
  return false;
}

function buildVttWordStream(cues, startMs, endMs, speaker) {
  var SLACK = 10000;
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
  return rawWords;
}

function normalizeSegment(text) {
  // Strip [bracket] added words, then split and normalize
  return text.replace(/\[[^\]]*\]/g, ' ')
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
    // Keep searching (FIXED: no early break on mismatch)
  }
  return {
    ok: false,
    end: from,
    msg: '"' + segWords.slice(0, 5).join(' ') + '" not found in VTT from position ' + from +
         '. VTT context: "' + vWords.slice(from, from + 12).join(' ') + '"'
  };
}

function extractQuoteTexts(blockHtml, isSynthesisArticle) {
  function decodeEntities(s) {
    return s
      .replace(/’|‘/g, "'")
      .replace(/“|”/g, '"')
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
    var t = decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    return t.length > 5 ? [t] : [];
  }
}


function strictVerbatimCheck(pageTexts, vttWordStream) {
  if (!vttWordStream || vttWordStream.length < 3) {
    return ['VTT extract empty — check speaker mapping and time range'];
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
        errors.push('Source ' + (ti+1) + ', segment ' + (si+1) + ': ' + result.msg);
        break; // stop at first failure per text
      }
      vIdx = result.end;
      // Gap between segments: any VTT words allowed (that is what … marks)
    }
    if (errors.length > 0) break; // stop at first failed source text
  }
  return errors;
}

var EPISODE_SPEAKERS = {
  'best-b2b-podcast-agency-for-ai-visibility': ['Casey Cheshire', 'Adam Needles'],
  'best-agency-to-get-my-brand-cited-by-chatgpt': ['Simon Wilhelm', 'Casey Cheshire'],
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
    var startMs = _toMs(tLine.slice(0, arrowIdx));
    var endMs   = _toMs(tLine.slice(arrowIdx + 3));
    var tIdx = lines.indexOf(tLine);
    var textLines = lines.slice(tIdx + 1).filter(function(l) { return l.trim(); });
    if (!textLines.length) continue;
    var speaker = '', cueText = '';
    var vm = textLines[0].match(/^<v ([^>]+)>/);
    if (vm) {
      speaker = vm[1]; lastSpeaker = speaker;
      cueText = textLines.map(function(l) { return l.replace(/^<v [^>]+>/, '').replace(/<\/v>/, '').trim(); }).join(' ');
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
  var errors = [];
  var slugs = fs.readdirSync(answersDir).filter(function(d) {
    return fs.statSync(path.join(answersDir, d)).isDirectory();
  });

  for (var si = 0; si < slugs.length; si++) {
    var slug = slugs[si];
    var speakers = EPISODE_SPEAKERS[slug];
    if (!speakers) continue; // no VTT mapping yet (e.g. future episodes)

    var file = path.join(answersDir, slug, 'index.html');
    if (!fs.existsSync(file)) continue;
    var html = fs.readFileSync(file, 'utf8');
    var excluded = slug === 'best-agency-to-get-my-brand-cited-by-chatgpt' ? EP002_EXCLUDED : [];

    // Match: <article class="qa-item" data-vtt-start="N" data-vtt-end="N" data-vtt-speaker="X">
    // If the HTML uses data-vtt-* attributes, use those; otherwise scan by answer label position
    var blockRe = /<article[^>]+data-vtt-speaker="([^"]+)"[^>]+data-vtt-start="([^"]+)"[^>]+data-vtt-end="([^"]+)"[^>]*>/g;
    var hasAttrs = blockRe.test(html);

    if (hasAttrs) {
      // Reset and iterate
      blockRe = /<article[^>]+data-vtt-speaker="([^"]+)"[^>]+data-vtt-start="([^"]+)"[^>]+data-vtt-end="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g;
      var m;
      while ((m = blockRe.exec(html)) !== null) {
        var speaker = m[1];
        var startMs = parseInt(m[2], 10);
        var endMs = parseInt(m[3], 10);
        var blockHtml = m[4];

        // Skip only the specific speaker-requested excluded ranges
        if (isExcluded(startMs, endMs, excluded)) continue;

        // Detect synthesis answers by presence of synthesis-source elements
        var isSynthesisBlock = blockHtml.indexOf('synthesis-source') >= 0 ||
                               blockHtml.indexOf('answer-label--synthesis') >= 0;

        // Extract quote texts to check (verbatim sources for synthesis, summary for verbatim/edited)
        var quoteTexts = extractQuoteTexts(blockHtml, isSynthesisBlock);
        if (!quoteTexts.length) continue;

        var cues = getVttCues(slug, answersDir, speakers);
        if (!cues.length) continue;
        var vttWordStream = buildVttWordStream(cues, startMs, endMs, speaker);

        var errs = strictVerbatimCheck(quoteTexts, vttWordStream);
        if (errs.length > 0) {
          var anchorM = blockHtml.match(/id="(q\d+)"/);
          var anchor = anchorM ? anchorM[1] : '?';
          errors.push(slug + ' ' + anchor + ':');
          errs.forEach(function(e) { errors.push('  • ' + e); });
        }
      }
    } else {
      // Fallback: warn but don't fail (HTML doesn't have data-vtt-* attributes yet)
      errors.push(slug + ': verbatim check skipped -- add data-vtt-speaker, data-vtt-start, data-vtt-end to every qa-item article');
    }
  }

  if (errors.length > 0) {
    console.error('\n✗ VERBATIM CHECK FAILED — fix before shipping:');
    errors.forEach(function(e) { console.error(e); });
    process.exit(1);
  }
  console.log('Verbatim check passed (' + slugs.length + ' episode' + (slugs.length === 1 ? '' : 's') + ').');
}




// ── Main ─────────────────────────────────────────────────────────────────────

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

console.log('Verbatim check: validating quoted text against VTT...');
verbatimCheckAnswerPages();

console.log('Build complete.');
