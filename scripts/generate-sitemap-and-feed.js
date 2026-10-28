#!/usr/bin/env node
/**
 * scripts/generate-sitemap-and-feed.js — writes the sitemap index, its child sitemaps and feed.xml
 * from the page files in the repo. Rewritten 2026-10-27 (cited-episode-publish, "Update the sitemap").
 *
 * Usage (from repo root):   node scripts/generate-sitemap-and-feed.js
 * The publish process runs this same file on every publish and commits its output.
 *
 * Output
 *   sitemap.xml            sitemap index (robots.txt, llms.txt and every footer point here)
 *   sitemap-pages.xml      core pages (home, methodology, FAQ, …)
 *   sitemap-answers.xml    the answers index and every answer page
 *   sitemap-speakers.xml   the speakers index and every speaker page
 *   sitemap-episodes.xml   the episodes index
 *   feed.xml               RSS of answer pages, newest first
 *   data/sitemap-meta.json per-URL lastmod + content fingerprint (what makes lastmod truthful)
 *
 * What is listed: see scripts/lib-sitemap.js — canonical, indexable, non-redirected pages only.
 * No changefreq / priority: Google ignores both and Bing documents them as unused.
 *
 * lastmod = when the page's content last changed, never the build time:
 *   - a page whose file is unchanged since the last run keeps its recorded lastmod;
 *   - a changed (or new) page gets the time from .sitemap-dates.json (written by the publish process:
 *     the page's last commit time, or the publish time for pages it is changing), else "now"
 *     (when you run it by hand right after editing a page, "now" is when the change ships);
 *   - pages with a JSON-LD dateModified always agree with it (same day).
 * feed.xml keeps every existing item's hand-written description exactly; new items take the
 * episode data file's description or the page's full meta description.
 */
var fs = require('fs');
var path = require('path');
var S = require('./lib-sitemap');

var ROOT = path.resolve(__dirname, '..');
var NOW = new Date().toISOString();

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; } }

var metaPath = path.join(ROOT, 'data', 'sitemap-meta.json');
var oldMeta = readJson(metaPath, null);
var metaPages = (oldMeta && !Array.isArray(oldMeta) && oldMeta.pages) ? oldMeta.pages : {};
var dates = readJson(path.join(ROOT, '.sitemap-dates.json'), {});

var inv = S.inventory(ROOT);
var newMeta = { schema: 2, note: 'Written by scripts/generate-sitemap-and-feed.js. lastmod = when the page content last changed; hash = fingerprint of the file at that time. Do not edit by hand.', pages: {} };
var usedNow = [];

inv.included.forEach(function (p) {
  var h = S.hash(p.html);
  var prev = metaPages[p.path];
  var t = (prev && prev.hash === h && prev.lastmod) ? prev.lastmod : (dates[p.file] || dates[p.path] || null);
  if (!t) { t = NOW; usedNow.push(p.path); }
  t = S.w3c(t);
  if (p.dateModified && t.slice(0, 10) !== p.dateModified.slice(0, 10)) t = S.w3c(p.dateModified);
  p.lastmod = t;
  newMeta.pages[p.path] = { lastmod: t, hash: h, file: p.file };
});

function ms(t) { return new Date(t.length === 10 ? t + 'T00:00:00Z' : t).getTime(); }
function byLoc(a, b) { return a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path); }

var children = [];
S.TYPES.forEach(function (type) {
  var list = inv.included.filter(function (p) { return p.type === type; }).sort(byLoc);
  if (!list.length) return;
  var xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    .concat(list.map(function (p) { return '  <url>\n    <loc>' + S.escapeXml(p.url) + '</loc>\n    <lastmod>' + p.lastmod + '</lastmod>\n  </url>'; }))
    .concat(['</urlset>', '']).join('\n');
  var newest = list.reduce(function (a, p) { return ms(p.lastmod) > ms(a) ? p.lastmod : a; }, list[0].lastmod);
  var file = 'sitemap-' + type + '.xml';
  fs.writeFileSync(path.join(ROOT, file), xml, 'utf8');
  children.push({ loc: S.SITE + '/' + file, lastmod: newest, count: list.length });
});

var index = ['<?xml version="1.0" encoding="UTF-8"?>', '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
  .concat(children.map(function (c) { return '  <sitemap>\n    <loc>' + c.loc + '</loc>\n    <lastmod>' + c.lastmod + '</lastmod>\n  </sitemap>'; }))
  .concat(['</sitemapindex>', '']).join('\n');
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), index, 'utf8');
fs.writeFileSync(metaPath, JSON.stringify(newMeta, null, 1) + '\n', 'utf8');

// ── feed.xml ────────────────────────────────────────────────────────────────
var feedPath = path.join(ROOT, 'feed.xml');
var oldFeed = fs.existsSync(feedPath) ? fs.readFileSync(feedPath, 'utf8') : '';
var oldItems = {};
(oldFeed.match(/<item>[\s\S]*?<\/item>/g) || []).forEach(function (it) {
  var g = (it.match(/<guid[^>]*>([^<]+)<\/guid>/) || [])[1];
  var d = (it.match(/<description>([\s\S]*?)<\/description>/) || [])[1];
  if (g) oldItems[g.trim()] = { description: d };
});
function rfc822(iso) { return new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso).toUTCString().replace(/GMT$/, '+0000'); }

var answers = inv.included.filter(function (p) { return p.type === 'answers' && p.path !== '/answers/'; })
  .sort(function (a, b) { return (b.datePublished || '').localeCompare(a.datePublished || ''); });
var items = answers.map(function (p) {
  var h1 = (p.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
  var title = S.escapeXml(S.decode(h1.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim());
  var desc = oldItems[p.url] && oldItems[p.url].description;
  if (!desc) {
    var slug = p.path.split('/')[2];
    var data = readJson(path.join(ROOT, 'data', 'episodes', slug + '.json'), null);
    var d = data && data.episode && data.episode.description ? data.episode.description : S.decode(S.metaContent(p.html, 'description') || '');
    var num = data && data.episode && data.episode.number ? ' Source: Episode ' + ('00' + data.episode.number).slice(-3) + '.' : '';
    desc = S.escapeXml(d + num);
  }
  return '    <item>\n      <title>' + title + '</title>\n      <link>' + p.url + '</link>\n      <description>' + desc + '</description>\n' +
    (p.datePublished ? '      <pubDate>' + rfc822(p.datePublished) + '</pubDate>\n' : '') +
    '      <guid isPermaLink="true">' + p.url + '</guid>\n    </item>';
});
var newestAnswer = answers.reduce(function (a, p) { return !a || ms(p.lastmod) > ms(a) ? p.lastmod : a; }, null);
var feed = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
  '  <channel>',
  '    <title>Cited Conversations \u2014 New Answer Pages</title>',
  '    <link>' + S.SITE + '/answers/</link>',
  '    <description>New expert answer pages from recorded human conversations, published by Ringmaster. Every claim cites its source \u2014 attributed to a named speaker and linked to the exact moment it was said.</description>',
  '    <language>en-us</language>',
  '    <copyright>Cited Conversations / Ringmaster</copyright>',
  '    <atom:link href="' + S.SITE + '/feed.xml" rel="self" type="application/rss+xml"/>',
  '    <atom:link href="' + S.SITE + '/sitemap.xml" rel="related" type="application/xml" title="Sitemap index"/>',
  newestAnswer ? '    <lastBuildDate>' + rfc822(newestAnswer) + '</lastBuildDate>' : null,
  '    <docs>https://www.rssboard.org/rss-specification</docs>',
  ''
].filter(function (l) { return l !== null; }).concat(items.map(function (i) { return i + '\n'; })).concat(['  </channel>', '</rss>', '']).join('\n');
fs.writeFileSync(feedPath, feed, 'utf8');

console.log('Wrote sitemap.xml (index of ' + children.length + ') + ' + children.map(function (c) { return c.loc.split('/').pop() + ' (' + c.count + ')'; }).join(', ') +
  '; feed.xml (' + items.length + ' items). Excluded ' + inv.excluded.length + ' page(s): ' + inv.excluded.map(function (e) { return e.path + ' — ' + e.reason; }).join('; '));
if (usedNow.length) console.log('lastmod set to now for changed pages with no known change time: ' + usedNow.join(', '));
