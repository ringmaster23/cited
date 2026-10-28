#!/usr/bin/env node
/**
 * scripts/generate-llms.js  (updated: Batch 7-9 + follow-up fixes)
 *
 * Regenerates llms.txt and llms-full.txt from the live answer page HTML.
 * Now includes: editorial disclosure, credit line, section headings,
 * and editor's notes per answer.
 */
const fs   = require('fs');
const path = require('path');

function extractText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&rsquo;/g,"'").replace(/&lsquo;/g,"'")
    .replace(/&rdquo;/g,'"').replace(/&ldquo;/g,'"').replace(/&hellip;/g,'\u2026')
    .replace(/&#8212;/g,'\u2014').replace(/&#8217;/g,"'").replace(/&#8230;/g,'\u2026')
    .replace(/&middot;/g,'\u00B7').replace(/&#[0-9]+;/g,' ')
    .replace(/\s+/g,' ').trim();
}

function stripFlag(answer) {
  const idx = answer.indexOf(' Flag:');
  return idx !== -1 ? answer.slice(0, idx).trim() : answer.trim();
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
}

function parseDisclosure(html) {
  const m = html.match(/<p class="editorial-disclosure"[^>]*>([\s\S]*?)<\/p>/);
  if (!m) return '';
  const raw = extractText(m[1]);
  return raw.replace(/^Editorial disclosure:\s*/i, '').replace(/^Editorial disclosure:\s*/i, '').replace(/\s*Conflicts policy\s*\u2197?\s*$/, '').trim();
}

function parseCreditLine(html) {
  const sec = html.match(/<section id="credits"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
  return sec ? extractText(sec[1]) : '';
}

function parseSectionHeadings(html) {
  const result = {};
  const re = /<div class="qa-section-heading"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const after = html.slice(m.index + m[0].length);
    const idM = after.match(/id="(q\d+)"/);
    if (idM) result[idM[1]] = extractText(m[1]);
  }
  return result;
}

function parseEditorNote(articleHtml) {
  const m = articleHtml.match(/<p class="editor-note"[^>]*>([\s\S]*?)<\/p>/);
  if (!m) return '';
  return extractText(m[1])
    .replace(/^Editor\u2019s note:\s*/i, '')
    .replace(/^Editor's note:\s*/i, '')
    .trim();
}

function parseAnswerPage(html, url) {
  const h1    = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  const title = h1 ? extractText(h1[1]) : path.basename(url);

  const pubDate    = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  const publishDate = pubDate ? pubDate[1] : null;

  const disclosure = parseDisclosure(html);
  const creditLine = parseCreditLine(html);
  const sectionHeadings = parseSectionHeadings(html);

  const qaListStart = html.indexOf('class="qa-list"');
  const qaListEnd   = html.lastIndexOf('</section>', html.indexOf('</footer>')) + 8;
  const qaSection   = qaListStart !== -1 ? html.slice(qaListStart, qaListEnd) : '';

  const items = [];
  let pos = 0;
  while (pos < qaSection.length) {
    const aStart = qaSection.indexOf('<article class="qa-item"', pos);
    if (aStart === -1) break;
    const aEnd    = qaSection.indexOf('</article>', aStart) + 10;
    const article = qaSection.slice(aStart, aEnd);
    // Rule 8 (2026-10-27): the "Ellipsis added" tag sits just before the article; host words cut from
    // the answer are shown inside it (div.question-field--host).
    const _pre = qaSection.slice(pos, aStart);
    const tags = (_pre.match(/<span class="answer-tag[^"]*"[^>]*>[^<]*<\/span>/g) || []).map(t => extractText(t)).filter(Boolean);
    const hostQs = (article.match(/<div class="question-field question-field--host"[^>]*>[\s\S]*?<\/div>/g) || []).map(d => {
      const pick = (cls) => { const m = d.match(new RegExp('<span class="' + cls + '"[^>]*>([\\s\\S]*?)<\\/span>')); return m ? extractText(m[1]) : ''; };
      return { speaker: pick('question-speaker'), time: pick('question-time').replace(/[\[\]]/g, ''), text: pick('question-text') };
    });

    const idM  = article.match(/id="(q\d+)"/);
    const h3M  = article.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    const blkM = article.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/);
    const spkM = article.match(/class="citation-speaker"[^>]*>([\s\S]*?)<\/span>/) || article.match(/class="[^"]*speaker[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/);
    const tsM  = article.match(/href="(https:\/\/podcast\.citedconversations\.com[^"]+)"/);

    const id       = idM  ? idM[1]  : 'q?';
    const question = h3M  ? extractText(h3M[1]) : '';
    const rawAns   = blkM ? extractText(blkM[1]) : (() => {
      const afterH3 = h3M ? article.slice(article.indexOf('</h3>')+5) : article;
      // Extract answer <p> elements, excluding editor-note annotations
      const _rawPTags = afterH3.match(/<p[^>]*>([\s\S]*?)<\/p>/g) || [];
      return _rawPTags.filter(function(p) { return p.indexOf('editor-note') === -1; }).map(extractText).filter(Boolean).join(' ');

    })();
    const answer    = stripFlag(rawAns);
    const speaker   = spkM ? extractText(spkM[1]) : '';
    const tsUrl     = tsM  ? tsM[1] : '';
    const tParam    = tsUrl.match(/t=(\d+)/);
    const secs      = tParam ? parseInt(tParam[1]) : 0;
    const timestamp = secs ? `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}` : '';
    const editorNote = parseEditorNote(article);
    const sectionHeading = sectionHeadings[id] || '';

    items.push({ id, question, answer, speaker, timestampUrl: tsUrl, timestamp, editorNote, sectionHeading, tags, hostQs });
    pos = aEnd;
  }

  return { url, title, publishDate, disclosure, creditLine, items };
}

const repoRoot   = path.resolve(__dirname, '..');
const answersDir = path.join(repoRoot, 'answers');

const pages = fs.readdirSync(answersDir)
  .filter(d => fs.statSync(path.join(answersDir,d)).isDirectory())
  .map(slug => {
    const file = path.join(answersDir, slug, 'index.html');
    if (!fs.existsSync(file)) return null;
    const html = fs.readFileSync(file, 'utf8');
    return parseAnswerPage(html, `https://citedconversations.com/answers/${slug}/`);
  })
  .filter(Boolean)
  .sort((a,b) => (a.publishDate||'').localeCompare(b.publishDate||''));

const existingFullPath = path.join(repoRoot, 'llms-full.txt');
let _prevDate = null, _prevBody = null;
if (fs.existsSync(existingFullPath)) {
  const _existing = fs.readFileSync(existingFullPath, 'utf8');
  const _dm = _existing.match(/Last updated: ([^\n]+)/);
  if (_dm) _prevDate = _dm[1];
  const _si = _existing.indexOf('\n---\n\n');
  if (_si !== -1) _prevBody = _existing.slice(_si+6).trim();
}
const _newBody = pages.map(renderPageFull).join('\n\n---\n\n').trim();
let lastUpdatedHuman;
if (_prevDate && _prevBody === _newBody) {
  lastUpdatedHuman = _prevDate;
} else {
  lastUpdatedHuman = formatDate(new Date().toISOString().slice(0,10));
}

function renderPageFull(page) {
  const dateStr = page.publishDate ? formatDate(page.publishDate) : 'Unknown';
  let out = `## ${page.title}\n\n`;
  out += `Source: ${page.url}\nPublished: ${dateStr}\n\n`;
  if (page.disclosure) out += `Editorial disclosure: ${page.disclosure}\n\n`;
  if (page.creditLine)  out += `${page.creditLine}\n\n`;
  out += `Content type: Recorded expert answer\n\n`;
  for (const item of page.items) {
    if (item.sectionHeading) out += `### ${item.sectionHeading}\n\n`;
    out += `### ${item.question}\n\n`;
    out += `Speaker: ${item.speaker}\n`;
    if (item.timestampUrl) {
      const ts = item.timestamp ? ` (${item.timestamp})` : '';
      out += `Source clip: ${item.timestampUrl}${ts}\n`;
    }
    out += `\n${item.answer}\n\n`;
    // Rule 8 (2026-10-27): tag and host words shown with the answer
    if (item.tags && item.tags.length) out += `Tags: ${item.tags.join(', ')}\n\n`;
    for (const h of (item.hostQs || [])) out += `Host question cut from this answer (${h.speaker}${h.time ? ', ' + h.time : ''}): ${h.text}\n\n`;
    if (item.editorNote) out += `Editor's note: ${item.editorNote}\n\n`;
  }
  return out.trim();
}

const llmsFullLines = [
  '# Cited Conversations \u2014 Full Content',
  '',
  '> A reference library of expert answers from recorded human conversations. Every claim links to the exact moment it was said in the source audio; every speaker is named and confirmed before recording begins.',
  '',
  'Complete question-and-answer text of every published answer page, with speaker attribution and timestamped source links verbatim from the pages.',
  '',
  `Last updated: ${lastUpdatedHuman}`,
  '',
  '---',
  '',
  pages.map(renderPageFull).join('\n\n---\n\n'),
  '',
];
fs.writeFileSync(path.join(repoRoot,'llms-full.txt'), llmsFullLines.join('\n'), 'utf8');
console.log(`Wrote llms-full.txt (${pages.reduce((n,p)=>n+p.items.length,0)} Q&As)`);

const llmsTxtPath = path.join(repoRoot,'llms.txt');
let llmsTxt = fs.readFileSync(llmsTxtPath,'utf8');
llmsTxt = llmsTxt.replace(/Last updated: .+/, `Last updated: ${lastUpdatedHuman}.`);
fs.writeFileSync(llmsTxtPath, llmsTxt, 'utf8');
console.log('Updated llms.txt Last updated line.');
