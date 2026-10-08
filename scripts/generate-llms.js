#!/usr/bin/env node
/**
 * scripts/generate-llms.js
 * Regenerates llms.txt and llms-full.txt from the live answer page HTML files.
 *
 * Usage (from repo root):
 *   node scripts/generate-llms.js
 *
 * Run this script every time a new answer or episode page ships, then commit
 * the updated llms.txt and llms-full.txt alongside the new page files.
 *
 * What it does:
 *   1. Reads every answers/*/index.html in the repo.
 *   2. Parses page title, publish date, speakers, and Q&A blocks.
 *   3. Derives "Last updated" from the most recent datePublished in those pages.
 *   4. Writes llms.txt (index with freshness line) and llms-full.txt (full Q&A).
 *
 * Dependencies: none (Node.js built-ins only).
 */

const fs = require("fs");
const path = require("path");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractText(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"').replace(/&ldquo;/g, '"')
    .replace(/&#8212;/g, "—").replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/&#8594;/g, "→").replace(/&middot;/g, "·")
    .replace(/\s+/g, " ").trim();
}

function stripFlag(answer) {
  const idx = answer.indexOf(" Flag:");
  return idx !== -1 ? answer.slice(0, idx).trim() : answer.trim();
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function parseAnswerPage(html, url) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? extractText(h1[1]) : path.basename(url);

  const pubDate = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  const publishDate = pubDate ? pubDate[1] : null;

  const qaListStart = html.indexOf('class="qa-list"');
  const qaListEnd = html.lastIndexOf("</section>", html.indexOf("</footer>")) + 8;
  const qaSection = qaListStart !== -1 ? html.slice(qaListStart, qaListEnd) : "";

  const items = [];
  let pos = 0;
  while (pos < qaSection.length) {
    const aStart = qaSection.indexOf('<article class="qa-item"', pos);
    if (aStart === -1) break;
    const aEnd = qaSection.indexOf("</article>", aStart) + 10;
    const article = qaSection.slice(aStart, aEnd);

    const idM = article.match(/id="(q\d+)"/);
    const h3M = article.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const blkM = article.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
    const spkM = article.match(/class="[^"]*speaker[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/);
    const tsM  = article.match(/href="(https:\/\/podcast\.citedconversations\.com[^"]+)"/);

    const id       = idM  ? idM[1]              : "q?";
    const question = h3M  ? extractText(h3M[1]) : "";
    const rawAns   = blkM ? extractText(blkM[1]) : (() => {
      const afterH3 = h3M ? article.slice(article.indexOf("</h3>") + 5) : article;
      return (afterH3.match(/<p[^>]*>([\s\S]*?)<\/p>/g) || [])
        .map(extractText).filter(Boolean).join(" ");
    })();
    const answer   = stripFlag(rawAns);
    const speaker  = spkM ? extractText(spkM[1]) : "";
    const tsUrl    = tsM  ? tsM[1] : "";
    const tParam   = tsUrl.match(/t=(\d+)/);
    const secs     = tParam ? parseInt(tParam[1]) : 0;
    const timestamp = secs ? `${Math.floor(secs/60)}:${String(secs%60).padStart(2,"0")}` : "";

    items.push({ id, question, answer, speaker, timestampUrl: tsUrl, timestamp });
    pos = aEnd;
  }

  return { url, title, publishDate, items };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(__dirname, "..");
const answersDir = path.join(repoRoot, "answers");

// Find all answers/*/index.html files
const pages = fs.readdirSync(answersDir)
  .filter(d => fs.statSync(path.join(answersDir, d)).isDirectory())
  .map(slug => {
    const file = path.join(answersDir, slug, "index.html");
    if (!fs.existsSync(file)) return null;
    const html = fs.readFileSync(file, "utf8");
    const url  = `https://citedconversations.com/answers/${slug}/`;
    return parseAnswerPage(html, url);
  })
  .filter(Boolean)
  .sort((a, b) => (a.publishDate || "").localeCompare(b.publishDate || ""));

// Derive last updated date
const latestDate = pages.reduce((latest, p) => {
  return p.publishDate && p.publishDate > latest ? p.publishDate : latest;
}, "");
const lastUpdatedISO  = latestDate || new Date().toISOString().slice(0, 10);
const lastUpdatedHuman = formatDate(lastUpdatedISO);

// ─── llms-full.txt ────────────────────────────────────────────────────────────

function renderPageFull(page) {
  const dateStr = page.publishDate ? formatDate(page.publishDate) : "Unknown";
  let out = `## ${page.title}\n\n`;
  out += `Source: ${page.url}\n`;
  out += `Published: ${dateStr}\n\n`;
  for (const item of page.items) {
    out += `### ${item.question}\n\n`;
    out += `Speaker: ${item.speaker}\n`;
    if (item.timestampUrl) {
      const ts = item.timestamp ? ` (${item.timestamp})` : "";
      out += `Source clip: ${item.timestampUrl}${ts}\n`;
    }
    out += `\n${item.answer}\n\n`;
  }
  return out.trim();
}

const llmsFullLines = [
  "# Cited Conversations — Full Content",
  "",
  "> A reference library of expert answers from recorded human conversations. Every claim links to the exact moment it was said in the source audio; every speaker is named and confirmed before recording begins.",
  "",
  "Complete question-and-answer text of every published answer page, with speaker attribution and timestamped source links verbatim from the pages. Run `node scripts/generate-llms.js` from the repo root to regenerate.",
  "",
  `Last updated: ${lastUpdatedHuman}`,
  "",
  "---",
  "",
  pages.map(renderPageFull).join("\n\n---\n\n"),
  "",
];
fs.writeFileSync(path.join(repoRoot, "llms-full.txt"), llmsFullLines.join("\n"), "utf8");
console.log(`Wrote llms-full.txt (${pages.reduce((n, p) => n + p.items.length, 0)} Q&As)`);

// ─── llms.txt (update freshness + listings) ───────────────────────────────────

// Read existing llms.txt and update only the "Last updated:" line
const llmsTxtPath = path.join(repoRoot, "llms.txt");
let llmsTxt = fs.readFileSync(llmsTxtPath, "utf8");
llmsTxt = llmsTxt.replace(
  /Last updated: .+/,
  `Last updated: ${lastUpdatedHuman}.`
);
fs.writeFileSync(llmsTxtPath, llmsTxt, "utf8");
console.log("Updated llms.txt Last updated line.");
