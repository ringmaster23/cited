#!/usr/bin/env node
/**
 * build.js — Cited Conversations static build script
 *
 * Copies all site files from repo root to dist/, excluding:
 *   .git/         — never deploy the git database
 *   functions/    — Pages Functions stay at repo root, not in output
 *   dist/         — avoid recursive copy
 *   build tooling — package.json, package-lock.json, build.js, wrangler.toml
 *
 * Post-processing steps (applied to dist/ after copy):
 *   1. Replace all href="/about/" → href="/methodology/" across every HTML file,
 *      so new pages added with the old path are corrected automatically.
 *   2. Inject live answer counts into the homepage conversation rows. Any
 *      <span data-answer-slug="…"> has its text updated to match the actual
 *      number of <article class="qa-item"> elements in that conversation's
 *      index.html, so counts can never drift from the real page again.
 *
 * Output: dist/  (set as pages_build_output_dir in wrangler.toml)
 */

const fs   = require('fs');
const path = require('path');

const ROOT    = __dirname;
const OUT     = path.join(ROOT, 'dist');
const EXCLUDE = new Set([
  '.git',
  'dist',
  'functions',
  'node_modules',
  'build.js',
  'wrangler.toml',
  'package.json',
  'package-lock.json',
]);

// ── Copy ─────────────────────────────────────────────────────────────────────

function copy(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const item of fs.readdirSync(src)) {
    if (EXCLUDE.has(item)) continue;
    const s = path.join(src, item);
    const d = path.join(dest, item);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) {
      copy(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// ── Post-process: /about/ → /methodology/ in all HTML ────────────────────────
// Catches any page where the nav or footer still references the old path,
// including pages added in future before their source is updated.

function patchAboutLinks(dir) {
  for (const item of fs.readdirSync(dir)) {
    const p = path.join(dir, item);
    if (fs.statSync(p).isDirectory()) {
      patchAboutLinks(p);
    } else if (item.endsWith('.html')) {
      const original = fs.readFileSync(p, 'utf8');
      const patched  = original
        .replaceAll('href="/about/"', 'href="/methodology/"')
        .replaceAll('href="/about"',  'href="/methodology/"');
      if (patched !== original) {
        fs.writeFileSync(p, patched, 'utf8');
      }
    }
  }
}

// ── Post-process: inject real answer counts into homepage ─────────────────────
// Finds every <span data-answer-slug="…"> in dist/index.html and replaces
// its text with the actual count of <article class="qa-item"> in the
// corresponding answers/{slug}/index.html.

function countQaItems(slug) {
  const file = path.join(OUT, 'answers', slug, 'index.html');
  if (!fs.existsSync(file)) return 0;
  const html = fs.readFileSync(file, 'utf8');
  return (html.match(/class="qa-item"/g) || []).length;
}

function patchHomepageCounts() {
  const idxPath = path.join(OUT, 'index.html');
  if (!fs.existsSync(idxPath)) return;
  let html = fs.readFileSync(idxPath, 'utf8');

  // Match any <span … data-answer-slug="SLUG" …>N more answers</span>
  // and replace N with the live count from the answer page.
  html = html.replace(
    /(<span[^>]+data-answer-slug="([^"]+)"[^>]*>)\d+ more answers(<\/span>)/g,
    (match, open, slug, close) => {
      const count = countQaItems(slug);
      return `${open}${count} more answers${close}`;
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
