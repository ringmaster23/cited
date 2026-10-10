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

// Strict filler: only um/uh/er/ah/hmm; immediately repeated words; Descript false-start fragments (trailing hyphen)
var VTT_STRICT_FILLER = new Set(['um','uh','er','ah','hmm']);
var TRAILING_HYPHEN_PAT = /^[a-z]{1,8}-$/i; // Descript false-start: "th-", "ar-", "f-", "com-" etc.

function isFiller(w, prevWord) {
  // Named fillers only
  if (VTT_STRICT_FILLER.has(w.toLowerCase())) return true;
  // Descript false-start: word ends with hyphen (e.g. "tech-", "f-")
  if (TRAILING_HYPHEN_PAT.test(w)) return true;
  // Immediately repeated word ("the, the" — VTT stutters)
  if (prevWord && w.toLowerCase() === prevWord.toLowerCase()) return true;
  return false;
}

function parseVttStrict(content, knownSpeakers) {
  var cues = [];
  var blocks = content.split(/\n\n+/);
  var lastSpeaker = '';
  for (var i = 0; i < blocks.length; i++) {
    var lines = blocks[i].trim().split('\n');
    var ti = -1;
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].indexOf(' --> ') >= 0) { ti = j; break; }
    }
    if (ti < 0) continue;
    var parts = lines[ti].split(' --> ');
    var startMs = vttParseMs(parts[0]);
    var endMs = vttParseMs(parts[1].split(' ')[0]);
    var textRaw = lines.slice(ti + 1).join(' ').trim();
    var trackM = textRaw.match(/^([A-Za-z][A-Za-z0-9_-]*[_-][A-Za-z0-9_-]+):\s*([\s\S]*)$/);
    var nameM = textRaw.match(/^([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?):\s*([\s\S]*)$/);
    var speaker = lastSpeaker;
    var text = textRaw;
    if (trackM) {
      var raw = trackM[1].toLowerCase();
      for (var k = 0; k < knownSpeakers.length; k++) {
        if (raw.indexOf(knownSpeakers[k].split(' ')[0].toLowerCase()) >= 0) {
          speaker = knownSpeakers[k]; lastSpeaker = speaker; break;
        }
      }
      text = trackM[2];
    } else if (nameM) {
      for (var k = 0; k < knownSpeakers.length; k++) {
        if (nameM[1] === knownSpeakers[k]) { speaker = knownSpeakers[k]; lastSpeaker = speaker; break; }
      }
      if (speaker === nameM[1]) text = nameM[2];
    }
    if (speaker) cues.push({ startMs: startMs, endMs: endMs, speaker: speaker, text: text.trim() });
  }
  return cues;
}

function vttParseMs(ts) {
  var p = ts.trim().split(':');
  if (p.length === 3) return Math.round((+p[0]*3600 + +p[1]*60 + parseFloat(p[2]))*1000);
  return Math.round((+p[0]*60 + parseFloat(p[1]))*1000);
}

function extractVttWindow(cues, startMs, endMs, speaker) {
  var SLACK = 10000;
  return cues
    .filter(function(c) { return c.speaker === speaker && c.endMs >= startMs - SLACK && c.startMs <= endMs + SLACK; })
    .map(function(c) { return c.text; }).join(' ').replace(/\s+/g, ' ').trim();
}

// Core strict check: returns array of error strings (empty = pass)
function strictVerbatimCheck(pageQuote, vttText) {
  if (!vttText || vttText.length < 10) return ['VTT extract empty — check speaker mapping and time range'];

  // Strip [bracket] added words (allowed); record them for reporting
  var stripped = pageQuote.replace(/\[([^\]]+)\]/g, '');

  // Split on ellipsis markers (… or ...) → contiguous segments
  var segments = stripped.split(/\u2026|\.\.\./);

  var vWords = vttWords(vttText);
  var vIdx = 0; // current position in VTT word array
  var errors = [];

  for (var si = 0; si < segments.length; si++) {
    var segWords = vttWords(segments[si]);
    if (segWords.length === 0) continue;

    // Find this segment as a subsequence in VTT from vIdx
    var segStart = -1;
    var matchLen = 0;
    var vi = vIdx;

    // For efficiency, find the first word, then check consecutive
    while (vi < vWords.length) {
      if (vWords[vi] === segWords[0]) {
        // Try to match all segment words consecutively from here
        // Allow filler words between matches (they may appear in VTT but not in page excerpt)
        var seqOk = true;
        var fillerSkipped = [];
        var checkVi = vi;
        var checkSi = 0;

        while (checkSi < segWords.length && checkVi < vWords.length) {
          if (vWords[checkVi] === segWords[checkSi]) {
            // Exact match
            checkSi++;
            checkVi++;
          } else if (isFiller(vWords[checkVi], vWords[checkVi - 1])) {
            // VTT has filler; skip it
            fillerSkipped.push(vWords[checkVi]);
            checkVi++;
          } else if (checkSi === 0) {
            // First word doesn't match and next VTT word isn't filler either
            break;
          } else {
            // Page word not matching VTT at this position: real mismatch
            seqOk = false;
            errors.push(
              'Segment ' + (si + 1) + ', word ' + (checkSi + 1) + ': page has "' + segWords[checkSi] + '" but VTT has "' + vWords[checkVi] + '"' +
              (fillerSkipped.length ? ' (skipped VTT filler: ' + fillerSkipped.join(', ') + ')' : '')
            );
            checkSi++;
            checkVi++;
          }
        }

        if (seqOk && checkSi === segWords.length) {
          // Matched all segment words
          segStart = vi;
          matchLen = checkVi - vi;
          vIdx = checkVi;
          break;
        }
        // Didn't match starting at vi; try next position
        if (!seqOk) break; // real mismatch found, don't search further
      }
      vi++;
    }

    if (segStart < 0 && errors.length === 0) {
      // Could not find segment in VTT at all
      errors.push(
        'Segment ' + (si + 1) + ' not found in VTT after position ' + vIdx + '. First few segment words: ' +
        segWords.slice(0, 6).join(' ')
      );
    }

    // Between segments, verify ellipsis gap contains only filler in VTT
    if (si < segments.length - 1 && segStart >= 0) {
      // vIdx now points to where next segment should start
      // Any VTT words between vIdx and where next segment starts should be filler
      var nextSegWords = vttWords(segments[si + 1]);
      if (nextSegWords.length > 0) {
        // Look ahead to find next segment start
        var nextStart = vIdx;
        while (nextStart < vWords.length && vWords[nextStart] !== nextSegWords[0]) {
          if (!isFiller(vWords[nextStart], vWords[nextStart - 1])) {
            errors.push(
              'Ellipsis between segment ' + (si + 1) + ' and ' + (si + 2) + ' skips non-filler VTT word: "' + vWords[nextStart] + '"'
            );
            if (errors.length > 3) break; // cap error count
          }
          nextStart++;
        }
      }
    }
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

        // Skip excluded ranges and synthesis blocks
        if (isExcluded(startMs, endMs, excluded)) continue;
        if (blockHtml.indexOf('answer-label--synthesis') >= 0) continue;

        // Extract quote text
        var quoteM = blockHtml.match(/<div class="qa-item__paper">([\s\S]*?)<\/div>/);
        if (!quoteM) continue;
        var quoteText = quoteM[1].replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"').replace(/&hellip;/g, '…').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

        var cues = getVttCues(slug, answersDir, speakers);
        if (!cues.length) continue;
        var vttText = extractVttWindow(cues, startMs, endMs, speaker);

        var errs = strictVerbatimCheck(quoteText, vttText);
        if (errs.length > 0) {
          var anchorM = blockHtml.match(/id="(q\d+)"/);
          var anchor = anchorM ? anchorM[1] : '?';
          errors.push(slug + ' ' + anchor + ':');
          errs.forEach(function(e) { errors.push('  • ' + e); });
        }
      }
    } else {
      // Fallback: warn but don't fail (HTML doesn't have data-vtt-* attributes yet)
      errors.push(slug + ': answer articles lack data-vtt-* attributes — add data-vtt-speaker, data-vtt-start, data-vtt-end to every <article class="qa-item">. Verbatim check cannot run' — verbatim check skipped. Add data-vtt-speaker, data-vtt-start, data-vtt-end to every <article class="qa-item">.');
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
