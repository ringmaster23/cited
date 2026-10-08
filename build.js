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

console.log('Building dist/ ...');
copy(ROOT, OUT);
console.log('Build complete.');
