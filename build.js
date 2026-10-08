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

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('Building dist/ ...');
copy(ROOT, OUT);

console.log('Post-processing: patching /about/ links ...');
patchAboutLinks(OUT);

console.log('Post-processing: injecting answer counts ...');
patchHomepageCounts();

console.log('Integrity check: validating answer pages ...');
integrityCheckAnswerPages();

console.log('Build complete.');
