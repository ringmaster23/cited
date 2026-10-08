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
 *
 * Note: uses .replace() with global regex (not .replaceAll) for Node 14 compat.
 *
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
// Badge format: "N answers" (total count, not additional-beyond-featured)

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

  // Replace "N answers" inside any span that carries data-answer-slug
  html = html.replace(
    /(<span[^>]+data-answer-slug="([^"]+)"[^>]*>)\d+ answers(<\/span>)/g,
    function(match, open, slug, close) {
      var count = countQaItems(slug);
      return open + count + ' answers' + close;
    }
  );

  fs.writeFileSync(idxPath, html, 'utf8');
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('Building dist/ ...');
copy(ROOT, OUT);

console.log('Post-processing: patching /about/ links ...');
patchAboutLinks(OUT);

console.log('Post-processing: injecting answer counts ...');
patchHomepageCounts();

console.log('Build complete.');
