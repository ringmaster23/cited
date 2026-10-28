/**
 * scripts/sitemap-gate.js — build gate for the sitemap index, child sitemaps and feed.xml.
 * Called from build.js; findings go to dist/build-report.json under check "sitemap" and fail the build.
 *
 * Fails when: the XML is not well formed or breaks the sitemaps.org 0.9 schema (allowed elements,
 * one <loc> per entry, absolute https loc on this site, W3C lastmod); a live answer, speaker, episode
 * or core page is missing, or anything else is listed; a listed URL redirects or has no page; a
 * lastmod is in the future, earlier than the page's datePublished, or disagrees with its
 * dateModified; a URL is listed twice (trailing-slash variants count); an index lastmod is not the
 * newest lastmod in its child; a file passes 50,000 URLs or 50 MB; an answer page has no feed item.
 * Warns (never fails) when a page changed since the generator last ran.
 */
var fs = require('fs');
var path = require('path');
var S = require('./lib-sitemap');

function tokens(xml) {
  var out = [], re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g, m;
  while ((m = re.exec(xml)) !== null) out.push({ close: !!m[1], name: m[2], attrs: m[3], self: !!m[4], at: m.index, end: re.lastIndex });
  return out;
}

// Structural validation against the sitemaps.org 0.9 schema (urlset / sitemapindex).
function parseSitemap(xml, file, err) {
  var entries = [];
  if (!/^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(xml)) err(file + ': must start with <?xml version="1.0" encoding="UTF-8"?>');
  var body = xml.replace(/^<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<(?!\/?[A-Za-z])/.test(body.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''))) err(file + ': contains a "<" that is not a tag');
  if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(body)) err(file + ': contains an unescaped "&"');
  var t = tokens(body), stack = [];
  for (var i = 0; i < t.length; i++) {
    if (t[i].self) continue;
    if (!t[i].close) stack.push(t[i].name);
    else if (stack.pop() !== t[i].name) { err(file + ': tags are not balanced near </' + t[i].name + '>'); return { root: null, entries: [] }; }
  }
  if (stack.length) err(file + ': unclosed <' + stack[stack.length - 1] + '>');
  var root = t.length ? t[0].name : null;
  if (root !== 'urlset' && root !== 'sitemapindex') { err(file + ': root element must be <urlset> or <sitemapindex>'); return { root: root, entries: [] }; }
  if (!/xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(t[0].attrs)) err(file + ': root element must declare xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  var entryTag = root === 'urlset' ? 'url' : 'sitemap';
  var allowed = root === 'urlset' ? { loc: 1, lastmod: 1, changefreq: 1, priority: 1 } : { loc: 1, lastmod: 1 };
  var re = new RegExp('<' + entryTag + '>([\\s\\S]*?)</' + entryTag + '>', 'g'), m;
  var inner = body.replace(new RegExp('^\\s*<' + root + '[^>]*>'), '').replace(new RegExp('</' + root + '>\\s*$'), '');
  if (inner.replace(re, '').trim()) err(file + ': has content other than <' + entryTag + '> entries inside <' + root + '>');
  while ((m = re.exec(inner)) !== null) {
    var e = m[1], kids = tokens(e).filter(function (k) { return !k.close; }).map(function (k) { return k.name; });
    kids.forEach(function (k) { if (!allowed[k]) err(file + ': <' + entryTag + '> contains <' + k + '>, which the schema does not allow'); });
    var locs = e.match(/<loc>([^<]*)<\/loc>/g) || [];
    if (locs.length !== 1) { err(file + ': an entry has ' + locs.length + ' <loc> elements (needs exactly 1)'); continue; }
    var loc = locs[0].replace(/<\/?loc>/g, '').trim();
    var lm = (e.match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1];
    if ((e.match(/<lastmod>/g) || []).length > 1) err(file + ': ' + loc + ' has more than one <lastmod>');
    if (loc.length > 2048) err(file + ': ' + loc.slice(0, 60) + '… is longer than 2,048 characters');
    if (loc.indexOf(S.SITE + '/') !== 0) err(file + ': ' + loc + ' is not an absolute https URL on ' + S.SITE);
    if (lm !== undefined && !S.W3C_RE.test(lm.trim())) err(file + ': ' + loc + ' has lastmod "' + lm + '", which is not a W3C datetime');
    entries.push({ loc: loc, lastmod: lm ? lm.trim() : null });
  }
  return { root: root, entries: entries };
}

function ms(t) { return new Date(t.length === 10 ? t + 'T00:00:00Z' : t).getTime(); }

function run(ROOT, OUT, reportError, reportWarning, log) {
  var found = 0;
  function err(msg) { found++; log.error('\u2717 SITEMAP ' + msg); reportError('sitemap', null, null, null, msg); }
  function warn(msg) { log.warn('  \u26a0 SITEMAP ' + msg); reportWarning('sitemap', null, null, null, msg); }
  var now = Date.now();
  var idxPath = path.join(OUT, 'sitemap.xml');
  if (!fs.existsSync(idxPath)) { err('sitemap.xml is missing'); return found; }
  var idxXml = fs.readFileSync(idxPath, 'utf8');
  var idx = parseSitemap(idxXml, 'sitemap.xml', err);
  var listed = [];
  var files = [];
  if (idx.root === 'sitemapindex') {
    if (idx.entries.length > S.MAX_URLS) err('sitemap.xml lists more than 50,000 sitemaps');
    idx.entries.forEach(function (c) {
      var name = c.loc.replace(S.SITE + '/', '');
      var p = path.join(OUT, name);
      if (!/^sitemap-[a-z]+\.xml$/.test(name) || !fs.existsSync(p)) { err('sitemap.xml points to ' + c.loc + ', which is not in the build'); return; }
      var xml = fs.readFileSync(p, 'utf8');
      files.push({ name: name, bytes: Buffer.byteLength(xml, 'utf8') });
      var child = parseSitemap(xml, name, err);
      if (child.root !== 'urlset') { err(name + ' must be a <urlset>'); return; }
      if (child.entries.length > S.MAX_URLS) err(name + ' lists more than 50,000 URLs');
      var newest = child.entries.reduce(function (a, e) { return e.lastmod && (!a || ms(e.lastmod) > ms(a)) ? e.lastmod : a; }, null);
      if (newest && c.lastmod !== newest) err('sitemap.xml says ' + name + ' last changed ' + c.lastmod + ', but the newest lastmod inside it is ' + newest);
      child.entries.forEach(function (e) { listed.push({ loc: e.loc, lastmod: e.lastmod, file: name }); });
    });
  } else if (idx.root === 'urlset') {
    idx.entries.forEach(function (e) { listed.push({ loc: e.loc, lastmod: e.lastmod, file: 'sitemap.xml' }); });
  }
  files.push({ name: 'sitemap.xml', bytes: Buffer.byteLength(idxXml, 'utf8') });
  files.forEach(function (f) { if (f.bytes > S.MAX_BYTES) err(f.name + ' is larger than 50 MB'); });

  var inv = S.inventory(ROOT);
  var want = {};
  inv.included.forEach(function (p) { want[p.url] = p; });
  var seen = {};
  listed.forEach(function (e) {
    var key = e.loc.replace(/\/index\.html$/, '/').replace(/\/$/, '');
    if (seen[key]) err(e.loc + ' is listed twice (' + seen[key] + ' and ' + e.file + ')');
    seen[key] = e.file;
    var urlPath = e.loc.replace(S.SITE, '');
    var red = S.redirectFor(urlPath, inv.rules);
    if (red) err(e.loc + ' redirects to ' + red.to + ' \u2014 only final URLs belong in the sitemap');
    var distFile = path.join(OUT, urlPath.replace(/^\//, ''), urlPath.slice(-1) === '/' ? 'index.html' : '');
    if (!fs.existsSync(distFile) || fs.statSync(distFile).isDirectory()) err(e.loc + ' has no page in the build (it would 404)');
    var page = want[e.loc];
    if (!page) { if (!red) err(e.loc + ' is listed but is not an indexable page (no matching canonical, or noindex)'); return; }
    if (!e.lastmod) { err(e.loc + ' has no lastmod'); return; }
    if (ms(e.lastmod) > now + 10 * 60000) err(e.loc + ' has lastmod ' + e.lastmod + ', which is in the future');
    if (page.datePublished && e.lastmod.slice(0, 10) < page.datePublished.slice(0, 10)) err(e.loc + ' has lastmod ' + e.lastmod + ', earlier than its datePublished ' + page.datePublished);
    if (page.dateModified && e.lastmod.slice(0, 10) !== page.dateModified.slice(0, 10)) err(e.loc + ' has lastmod ' + e.lastmod + ' but the page says dateModified ' + page.dateModified);
  });
  inv.included.forEach(function (p) { if (!seen[p.url.replace(/\/$/, '')]) err(p.url + ' is a live ' + p.type + ' page but is missing from the sitemap'); });

  var meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sitemap-meta.json'), 'utf8')).pages || {}; } catch (e2) { meta = {}; }
  inv.included.forEach(function (p) { var m = meta[p.path]; if (!m || m.hash !== S.hash(p.html)) warn(p.path + ' changed since the sitemap was last generated, so its lastmod may be stale \u2014 run node scripts/generate-sitemap-and-feed.js'); });

  var feedPath = path.join(OUT, 'feed.xml');
  if (!fs.existsSync(feedPath)) err('feed.xml is missing');
  else {
    var feed = fs.readFileSync(feedPath, 'utf8');
    var t = tokens(feed.replace(/^<\?xml[^>]*\?>/, '')), st = [];
    for (var i = 0; i < t.length; i++) { if (t[i].self) continue; if (!t[i].close) st.push(t[i].name); else if (st.pop() !== t[i].name) { err('feed.xml: tags are not balanced near </' + t[i].name + '>'); break; } }
    inv.included.filter(function (p) { return p.type === 'answers' && p.path !== '/answers/'; }).forEach(function (p) {
      var item = (feed.match(new RegExp('<item>(?:(?!</item>)[\\s\\S])*<guid isPermaLink="true">' + p.url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '</guid>[\\s\\S]*?</item>')) || [])[0];
      if (!item) { err('feed.xml has no item for ' + p.url); return; }
      var d = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';
      if (d.trim().length < 40) err('feed.xml item for ' + p.url + ' has a missing or very short description');
      if (!/<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}<\/pubDate>/.test(item)) err('feed.xml item for ' + p.url + ' has no valid pubDate');
    });
  }
  if (!found) log.log('Sitemap gate passed (' + listed.length + ' URLs in ' + Math.max(1, files.length - 1) + ' sitemap file(s); ' + inv.excluded.length + ' non-canonical/redirected page(s) correctly left out).');
  return found;
}

module.exports = { run: run, parseSitemap: parseSitemap };
