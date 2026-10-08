#!/usr/bin/env node
/**
 * scripts/generate-sitemap-and-feed.js
 * Regenerates sitemap.xml and feed.xml from live page files.
 *
 * Usage (from repo root):
 *   node scripts/generate-sitemap-and-feed.js
 *
 * Run this every time a new answer page or speaker page ships, then commit
 * sitemap.xml and feed.xml alongside the new page files.
 *
 * How lastmod is derived:
 *   - Static / infrastructure pages  → data/sitemap-meta.json (edit manually when content changes)
 *   - Answer pages                   → "dateModified" in JSON-LD if present, else "datePublished"
 *   - Speaker pages                  → <meta name="last-modified" content="YYYY-MM-DD"> if present,
 *                                       else falls back to the earliest answer-page date that names
 *                                       this speaker, else today's date
 *
 * How RSS pubDate is derived:
 *   - Answer pages only → "datePublished" from JSON-LD (original publication date)
 *   - Sorted newest first
 *
 * Dependencies: none (Node.js built-ins only).
 */

const fs   = require("fs");
const path = require("path");

const SITE = "https://citedconversations.com";
const ROOT = path.resolve(__dirname, "..");

// ── Helpers ────────────────────────────────────────────────────────────────

function isoToRFC822(iso) {
  // Convert ISO 8601 date string to RFC 822 for RSS
  const d = new Date(iso);
  return d.toUTCString().replace(/GMT$/, "+0000");
}

function isoDateOnly(iso) {
  // Return just YYYY-MM-DD portion
  return iso ? iso.slice(0, 10) : "";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractJsonLdField(html, field) {
  // Extract a scalar value from JSON-LD in the page — fast regex, not full parse
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, "g");
  let m;
  let first = null;
  while ((m = re.exec(html)) !== null) {
    if (!first) first = m[1];
  }
  return first;
}

function extractMeta(html, name) {
  // Extract <meta name="..." content="..."> value
  const re = new RegExp(`<meta\\s[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, "i");
  const m  = html.match(re) ||
             html.match(new RegExp(`<meta\\s[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["']`, "i"));
  return m ? m[1] : null;
}

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function extractDescription(html) {
  // Try meta description first, then first <p class="...lead"> or similar
  const metaDesc = extractMeta(html, "description");
  if (metaDesc) return metaDesc;
  const leadM = html.match(/<p[^>]*class="[^"]*(?:lead|subhead|intro)[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  if (leadM) return leadM[1].replace(/<[^>]+>/g, "").trim().slice(0, 200);
  return "";
}

// ── Read static page metadata ──────────────────────────────────────────────

const metaPath = path.join(ROOT, "data", "sitemap-meta.json");
const staticPages = JSON.parse(fs.readFileSync(metaPath, "utf8"));

// ── Scan answer pages ──────────────────────────────────────────────────────

const answersDir = path.join(ROOT, "answers");
const answerPages = fs.readdirSync(answersDir)
  .filter(d => fs.statSync(path.join(answersDir, d)).isDirectory())
  .map(slug => {
    const file = path.join(answersDir, slug, "index.html");
    if (!fs.existsSync(file)) return null;
    const html = fs.readFileSync(file, "utf8");
    const url  = `${SITE}/answers/${slug}/`;

    const datePublished = extractJsonLdField(html, "datePublished");
    const dateModified  = extractJsonLdField(html, "dateModified");
    // Sitemap lastmod: prefer dateModified (set when content is corrected), else datePublished
    const lastmod = isoDateOnly(dateModified || datePublished);
    // RSS pubDate: always the original publication date
    const pubDate = datePublished ? isoToRFC822(datePublished) : null;

    const title       = extractH1(html);
    const description = extractDescription(html);

    return { url, slug, lastmod, pubDate, title, description, datePublished };
  })
  .filter(Boolean)
  .sort((a, b) => {
    // Newest datePublished first for RSS; fall back to alphabetical
    const dA = a.datePublished || "";
    const dB = b.datePublished || "";
    return dB.localeCompare(dA);
  });

// ── Scan speaker pages ─────────────────────────────────────────────────────

const speakersDir = path.join(ROOT, "speakers");
const speakerPages = fs.readdirSync(speakersDir)
  .filter(d => {
    const p = path.join(speakersDir, d);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "index.html"));
  })
  .map(slug => {
    const file = path.join(speakersDir, slug, "index.html");
    const html = fs.readFileSync(file, "utf8");
    const url  = `${SITE}/speakers/${slug}/`;

    // Read meta tag if set by page builder
    let lastmod = extractMeta(html, "last-modified");

    if (!lastmod) {
      // Fall back: find earliest answer page that mentions this speaker slug
      const related = answerPages.filter(a =>
        html.includes(`/answers/${a.slug}/`) || a.url.includes(slug.replace("-", ""))
      );
      lastmod = related.length
        ? related.reduce((earliest, a) =>
            (!earliest || a.datePublished < earliest) ? a.datePublished : earliest, null
          )?.slice(0, 10) || todayISO()
        : todayISO();
    }

    return { url, lastmod, changefreq: "monthly", priority: "0.8" };
  });

// ── Build sitemap.xml ──────────────────────────────────────────────────────

function sitemapEntry({ url, lastmod, changefreq, priority }) {
  return [
    `  <url>`,
    `    <loc>${escapeXml(url)}</loc>`,
    lastmod     ? `    <lastmod>${lastmod}</lastmod>` : null,
    changefreq  ? `    <changefreq>${changefreq}</changefreq>` : null,
    priority    ? `    <priority>${priority}</priority>` : null,
    `  </url>`,
  ].filter(Boolean).join("\n");
}

const answerSitemapEntries = answerPages
  .slice() // sort by URL for consistent ordering in sitemap
  .sort((a, b) => a.url.localeCompare(b.url))
  .map(p => sitemapEntry({ url: p.url, lastmod: p.lastmod, changefreq: "monthly", priority: "0.9" }));

const speakerSitemapEntries = speakerPages
  .sort((a, b) => a.url.localeCompare(b.url))
  .map(p => sitemapEntry(p));

const staticEntries = staticPages.map(p =>
  sitemapEntry({ url: p.url, lastmod: p.lastmod, changefreq: p.changefreq, priority: p.priority })
);

// Build final XML — static pages first, then answers, then speakers
const sitemapXml = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
  ``,
  `  <!-- Static / infrastructure pages — update data/sitemap-meta.json when content changes -->`,
  ...staticEntries,
  ``,
  `  <!-- Answer pages — lastmod auto-derived from dateModified or datePublished in JSON-LD -->`,
  ...answerSitemapEntries,
  ``,
  `  <!-- Speaker pages — lastmod from <meta name="last-modified"> or earliest related episode -->`,
  ...speakerSitemapEntries,
  ``,
  `</urlset>`,
].join("\n");

fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemapXml, "utf8");
console.log(`Wrote sitemap.xml (${staticPages.length} static + ${answerPages.length} answer + ${speakerPages.length} speaker pages)`);

// ── Build feed.xml ─────────────────────────────────────────────────────────

const now = new Date().toUTCString().replace(/GMT$/, "+0000");
const feedItems = answerPages.map(p => {
  const desc = escapeXml(p.description || p.title);
  return [
    `    <item>`,
    `      <title>${escapeXml(p.title)}</title>`,
    `      <link>${escapeXml(p.url)}</link>`,
    `      <description>${desc}</description>`,
    p.pubDate ? `      <pubDate>${p.pubDate}</pubDate>` : null,
    `      <guid isPermaLink="true">${escapeXml(p.url)}</guid>`,
    `    </item>`,
  ].filter(Boolean).join("\n");
});

const feedXml = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
  `  <channel>`,
  `    <title>Cited Conversations — New Answer Pages</title>`,
  `    <link>${SITE}/answers/</link>`,
  `    <description>New expert answer pages from recorded human conversations, published by Ringmaster. Every claim cites its source — attributed to a named speaker and linked to the exact moment it was said.</description>`,
  `    <language>en-us</language>`,
  `    <copyright>Cited Conversations / Ringmaster</copyright>`,
  `    <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>`,
  `    <lastBuildDate>${now}</lastBuildDate>`,
  `    <docs>https://www.rssboard.org/rss-specification</docs>`,
  ``,
  ...feedItems,
  ``,
  `  </channel>`,
  `</rss>`,
].join("\n");

fs.writeFileSync(path.join(ROOT, "feed.xml"), feedXml, "utf8");
console.log(`Wrote feed.xml (${answerPages.length} answer pages, newest first)`);

// ── Summary ────────────────────────────────────────────────────────────────
console.log("\nDone. Commit sitemap.xml, feed.xml, and data/sitemap-meta.json together.");
console.log("When you add a new answer page:");
console.log("  1. Add answers/{slug}/index.html with datePublished in JSON-LD");
console.log("  2. Add speakers/{slug}/index.html with <meta name=\"last-modified\" content=\"YYYY-MM-DD\">");
console.log("  3. Run: node scripts/generate-sitemap-and-feed.js");
console.log("  4. Commit everything together");
