/**
 * scripts/lib-sitemap.js — shared rules for the sitemap generator and the build's sitemap gate.
 *
 * A URL belongs in the sitemap only if it is worth crawling: an index.html page whose
 * <link rel="canonical"> is exactly its own absolute https URL, that has no robots noindex,
 * and that no rule in _redirects sends elsewhere. Everything else (old /episodes/*-episode-00X/
 * and best-* paths, /about/, the _template, data files) stays out.
 *
 * Child sitemaps by type: pages (core), answers, speakers, episodes. /sitemap.xml is the index.
 */
var fs = require('fs');
var path = require('path');

var SITE = 'https://citedconversations.com';
var SKIP_DIRS = { '.git': 1, '.github': 1, 'dist': 1, 'functions': 1, 'scripts': 1, 'node_modules': 1, 'data': 1, 'docs': 1, 'code-history': 1, '.well-known': 1 };
var TYPES = ['pages', 'answers', 'speakers', 'episodes'];
var MAX_URLS = 50000, MAX_BYTES = 52428800;

function readRedirects(root) {
  var p = path.join(root, '_redirects');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return l && l.charAt(0) !== '#'; })
    .map(function (l) { var parts = l.split(/\s+/); return { from: parts[0], to: parts[1] || '', code: parts[2] || '301' }; })
    .filter(function (r) { return r.from && r.from.charAt(0) === '/' && /^30[1278]$/.test(r.code); });
}

// Does any redirect rule match this path (with or without its trailing slash)?
function redirectFor(urlPath, rules) {
  var variants = [urlPath, urlPath.replace(/\/$/, ''), urlPath + 'index.html'];
  for (var i = 0; i < rules.length; i++) {
    var f = rules[i].from;
    for (var j = 0; j < variants.length; j++) {
      var v = variants[j];
      if (f.slice(-1) === '*' ? v.indexOf(f.slice(0, -1)) === 0 : v === f) return rules[i];
    }
  }
  return null;
}

function attr(tag, name) {
  var m = tag.match(new RegExp('\\s' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
}

function canonicalOf(html) {
  var tags = html.match(/<link\b[^>]*>/gi) || [];
  for (var i = 0; i < tags.length; i++) if (/\srel\s*=\s*["']?canonical/i.test(tags[i])) return attr(tags[i], 'href');
  return null;
}

function metaContent(html, name) {
  var tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (var i = 0; i < tags.length; i++) if ((attr(tags[i], 'name') || '').toLowerCase() === name) return attr(tags[i], 'content');
  return null;
}

function decode(s) {
  var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', nbsp: ' ', middot: '\u00b7' };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCodePoint(parseInt(n, 10)); })
    .replace(/&([a-z]+);/gi, function (m, n) { var k = n.toLowerCase(); return named[k] !== undefined ? named[k] : m; });
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ldField(html, field) {
  var m = html.match(new RegExp('"' + field + '"\\s*:\\s*"([^"]+)"'));
  return m ? m[1] : null;
}

function typeOf(urlPath) {
  if (urlPath.indexOf('/answers/') === 0) return 'answers';
  if (urlPath.indexOf('/speakers/') === 0) return 'speakers';
  if (urlPath.indexOf('/episodes/') === 0) return 'episodes';
  return 'pages';
}

// Every index.html under root, judged against the rules. Returns { included: [...], excluded: [...] }.
function inventory(root) {
  var rules = readRedirects(root);
  var included = [], excluded = [];
  (function walk(dir, rel) {
    var names = fs.readdirSync(dir).sort();
    for (var i = 0; i < names.length; i++) {
      var name = names[i], full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { if (!SKIP_DIRS[name]) walk(full, rel + name + '/'); continue; }
      if (name !== 'index.html') continue;
      var urlPath = '/' + rel;
      var html = fs.readFileSync(full, 'utf8');
      var canon = canonicalOf(html);
      var robots = (metaContent(html, 'robots') || '').toLowerCase();
      var red = redirectFor(urlPath, rules);
      var file = rel + 'index.html';
      var reason = red ? 'redirects to ' + red.to + ' (' + red.code + ')'
        : /noindex/.test(robots) ? 'robots noindex'
        : !canon ? 'no canonical tag'
        : canon !== SITE + urlPath ? 'canonical points to ' + canon
        : null;
      if (reason) { excluded.push({ path: urlPath, file: file, reason: reason }); continue; }
      included.push({ path: urlPath, url: SITE + urlPath, file: file, type: typeOf(urlPath), html: html,
        dateModified: ldField(html, 'dateModified'), datePublished: ldField(html, 'datePublished') });
    }
  })(root, '');
  return { included: included, excluded: excluded, rules: rules };
}

// FNV-1a 32-bit, hex — detects that a page's file changed since the last sitemap run.
function hash(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

// W3C datetime with timezone: 2026-10-27T17:07:24+00:00 (date-only values stay date-only).
function w3c(iso) {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00').replace(/Z$/, '+00:00');
}

var W3C_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

module.exports = { SITE: SITE, TYPES: TYPES, MAX_URLS: MAX_URLS, MAX_BYTES: MAX_BYTES, W3C_RE: W3C_RE,
  inventory: inventory, readRedirects: readRedirects, redirectFor: redirectFor, canonicalOf: canonicalOf,
  metaContent: metaContent, decode: decode, escapeXml: escapeXml, ldField: ldField, typeOf: typeOf, hash: hash, w3c: w3c };
