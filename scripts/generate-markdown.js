#!/usr/bin/env node
/**
 * generate-markdown.js  (updated: Batch 7-9 + follow-up fixes)
 *
 * Generates a .md file alongside every .html file in dist/.
 * Answer pages include: editorial disclosure, credit line, section headings,
 * editor's notes, and verbatim Q&A with speaker attribution.
 */

'use strict';

var fs   = require('fs');
var path = require('path');

var NAMED_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#8230;': '\u2026', '&#8212;': '\u2014', '&#8211;': '\u2013',
  '&#8217;': '\u2019', '&#8220;': '\u201C', '&#8221;': '\u201D',
  '&nbsp;': ' ', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
  '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&mdash;': '\u2014',
  '&ndash;': '\u2013', '&hellip;': '\u2026',
};

function decodeHtml(str) {
  if (!str) return '';
  str = str.replace(/&[a-z]+;/g, function(e) {
    return NAMED_ENTITIES[e] !== undefined ? NAMED_ENTITIES[e] : e;
  });
  str = str.replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); });
  return str;
}

function stripTags(h) { return h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function et(h) { return decodeHtml(stripTags(h)); }

function yamlValue(val) {
  if (!/[:#\[\]{}&*!,|>'"%@`\r\n]/.test(val) && !/^\s/.test(val) && !/\s$/.test(val)) return val;
  return '"' + val.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function extractMeta(html) {
  var titleM = html.match(/<title>([^<]*)<\/title>/i);
  var descM  = html.match(/name="description"\s+content="([^"]*)"/i) ||
               html.match(/content="([^"]*)"\s+name="description"/i);
  var imageM = html.match(/property="og:image"\s+content="([^"]*)"/i) ||
               html.match(/content="([^"]*)"\s+property="og:image"/i);
  return {
    title: decodeHtml((titleM||[])[1]||''),
    desc:  decodeHtml((descM ||[])[1]||''),
    image: (imageM||[])[1]||'',
  };
}

function buildFrontmatter(meta) {
  var lines = ['---'];
  if (meta.title) lines.push('title: ' + yamlValue(meta.title));
  if (meta.desc)  lines.push('description: ' + yamlValue(meta.desc));
  if (meta.image) lines.push('image: ' + yamlValue(meta.image));
  lines.push('---', '');
  return lines.join('\n') + '\n';
}

function extractJsonLd(html) {
  var m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return { raw: m[1].trim(), parsed: JSON.parse(m[1]) }; }
  catch (_) { return { raw: m[1].trim(), parsed: null }; }
}

function padStart(str, fill, len) {
  str = String(str);
  while (str.length < len) str = fill + str;
  return str;
}
function fmt(secs) {
  secs = Math.round(secs);
  return String(Math.floor(secs/60)) + ':' + padStart(String(secs%60),'0',2);
}

function cleanQuoteText(raw) {
  if (!raw) return '';
  var s = decodeHtml(raw);
  s = s.replace(/\s*&\s+/g, '\n>\n> ');
  s = s.replace(/  +/g, ' ').trim();
  return s;
}

// ── Parse editorial additions from HTML body ──────────────────────────────────

function parseDisclosure(html) {
  var m = html.match(/<p class="editorial-disclosure"[^>]*>([\s\S]*?)<\/p>/);
  if (!m) return '';
  var txt = et(m[1]);
  // strip trailing "Conflicts policy" link text added by et
  const _disc = txt.replace(/\s*Conflicts policy\s*\u2197?\s*$/, '').trim();
  return _disc.replace(/^Editorial disclosure:\s*/i, '').replace(/\s*Conflicts policy[\s\S]*$/, '').trim();
}

function parseCreditLine(html) {
  var sec = html.match(/<section id="credits"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
  if (!sec) return '';
  return et(sec[1]);
}

function parseEditorNote(articleHtml) {
  var m = articleHtml.match(/<p class="editor-note"[^>]*>([\s\S]*?)<\/p>/);
  if (!m) return '';
  return et(m[1]).replace(/^Editor\u2019?s note:\s*/i, '').replace(/^Editor's note:\s*/i, '').trim();
}

function parseSectionHeadings(html) {
  // Returns a map of qId → heading text for any .qa-section-heading before that qId
  var result = {};
  var re = /<div class="qa-section-heading"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<\/div>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    // Find the next article id after this heading
    var after = html.slice(m.index + m[0].length);
    var idM = after.match(/id="(q\d+)"/);
    if (idM) result[idM[1]] = et(m[1]);
  }
  return result;
}

function parseArticleEditorNotes(html) {
  var notes = {};
  var re = /<article class="qa-item"[^>]*id="(q\d+)"[\s\S]*?<\/article>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    var qid = m[1];
    var note = parseEditorNote(m[0]);
    if (note) notes[qid] = note;
  }
  return notes;
}

// ── Answer page body generator ────────────────────────────────────────────────

function generateAnswerPageBody(title, desc, graph, html) {
  var lines = [];

  // 1. Title
  lines.push('# ' + title, '');

  // 2. Disclosure (plain text, right after title)
  var disclosure = parseDisclosure(html);
  if (disclosure) { lines.push('> **Editorial disclosure:** ' + disclosure, ''); }

  // 3. Credit line
  var credit = parseCreditLine(html);
  if (credit) { lines.push('> ' + credit, ''); }

  // 4. Episode metadata
  var episode = null, audio = null;
  var persons = {}, clips = [], quotations = [];
  for (var i = 0; i < graph.length; i++) {
    var node = graph[i];
    var t = node['@type'];
    if (t === 'PodcastEpisode') { episode = node; continue; }
    if (t === 'AudioObject')    { audio   = node; continue; }
    if (t === 'Person')         { if (node['@id']) persons[node['@id']] = node; continue; }
    if (t === 'Clip')           { clips.push(node); continue; }
    if (t === 'Quotation')      { quotations.push(node); continue; }
  }

  if (audio && audio.embedUrl) { lines.push('**Episode:** [Listen on podcast](' + audio.embedUrl + ')', ''); }
  if (episode) {
    if (episode.datePublished) { lines.push('**Published:** ' + episode.datePublished.split('T')[0], ''); }
    if (episode.description)   { lines.push(episode.description, ''); }
  }
  lines.push('---', '');

  // 5. Parse editor notes and section headings from HTML
  var editorNotes   = parseArticleEditorNotes(html);
  var sectionHeadings = parseSectionHeadings(html);

  // 6. Q&A blocks
  for (var ci = 0; ci < clips.length; ci++) {
    var clip = clips[ci];
    var quot = quotations[ci] || null;

    var qNumM = (clip['@id'] || '').match(/#(q\d+)-clip/i);
    var qId   = qNumM ? qNumM[1] : ('q' + (ci+1));
    var qLabel = qId.toUpperCase();

    // Section heading (e.g., "About the guest's company…") before this Q if present
    if (sectionHeadings[qId]) {
      lines.push('### ' + sectionHeadings[qId], '');
    }

    lines.push('## ' + qLabel + ': ' + clip.name, '');

    if (quot) {
      // Speaker attribution — use creator (spokenByCharacter removed in Batch 9)
      var speakerId = (quot.creator && quot.creator['@id']) ||
                      (quot.spokenByCharacter && quot.spokenByCharacter['@id']);
      if (speakerId && persons[speakerId]) {
        var p = persons[speakerId];
        var orgName = p.worksFor ? p.worksFor.name : '';
        var roleParts = [p.jobTitle, orgName].filter(Boolean).join(', ');
        lines.push('**' + p.name + '**' + (roleParts ? ' (' + roleParts + ')' : '') + ':', '');
      }

      var qText = cleanQuoteText(quot.text || '');
      if (qText) {
        var qLines = qText.split('\n');
        for (var qi = 0; qi < qLines.length; qi++) { lines.push('> ' + qLines[qi]); }
        lines.push('');
      }

      var citationUrl = quot.citation || (clip.url || '');
      if (citationUrl) {
        var tsM = citationUrl.match(/[?&]t=(\d+)/);
        var lbl = tsM ? '\u25B6 Listen at ' + fmt(+tsM[1]) : '\u25B6 Listen';
        lines.push('[' + lbl + '](' + citationUrl + ')', '');
      }
    } else if (clip.url) {
      var tsM2 = clip.url.match(/[?&]t=(\d+)/);
      var lbl2 = tsM2 ? '\u25B6 Listen at ' + fmt(+tsM2[1]) : '\u25B6 Listen';
      lines.push('[' + lbl2 + '](' + clip.url + ')', '');
    }

    // Editor's note for this Q (from HTML)
    var note = editorNotes[qId];
    if (note) { lines.push("*Editor's note: " + note + '*', ''); }

    lines.push('---', '');
  }

  return lines.join('\n');
}

// ── Generic / speaker pages ───────────────────────────────────────────────────

function stripTagsFn(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

function extractBodyText(html) {
  var bodyM = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
              html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyM) return '';
  var cleaned = bodyM[1]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');
  var text = decodeHtml(stripTagsFn(cleaned));
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 2500) text = text.slice(0, 2500) + ' \u2026';
  return text;
}

function generateGenericBody(title, desc, html) {
  var lines = [];
  lines.push('# ' + title, '');
  if (desc) { lines.push(desc, ''); }
  var body = extractBodyText(html);
  if (body && body.length > 60) { lines.push(body, ''); }
  return lines.join('\n');
}

function generateSpeakerBody(title, desc, graph) {
  var lines = [];
  lines.push('# ' + title, '');
  if (desc) { lines.push(desc, ''); }
  var person = null;
  for (var i = 0; i < graph.length; i++) {
    if (graph[i]['@type'] === 'Person') { person = graph[i]; break; }
  }
  if (person) {
    if (person.jobTitle)              { lines.push('**Title:** ' + person.jobTitle, ''); }
    if (person.worksFor && person.worksFor.name) { lines.push('**Organization:** ' + person.worksFor.name, ''); }
    if (person.description)           { lines.push(person.description, ''); }
    if (person.sameAs && person.sameAs.length) { lines.push('**Links:** ' + person.sameAs.join(' \u00B7 '), ''); }
  }
  return lines.join('\n');
}

function htmlToMarkdown(html) {
  var meta = extractMeta(html);
  var jld  = extractJsonLd(html);
  var body = '';
  var graph = jld && jld.parsed && jld.parsed['@graph'];
  if (graph && Array.isArray(graph)) {
    var hasClips   = graph.some(function(n) { return n['@type'] === 'Clip'; });
    var hasPerson  = graph.some(function(n) { return n['@type'] === 'Person'; });
    var hasEpisode = graph.some(function(n) { return n['@type'] === 'PodcastEpisode'; });
    if (hasClips && hasEpisode) {
      body = generateAnswerPageBody(meta.title, meta.desc, graph, html);
    } else if (hasPerson && !hasClips) {
      body = generateSpeakerBody(meta.title, meta.desc, graph);
    } else {
      body = generateGenericBody(meta.title, meta.desc, html);
    }
  } else {
    body = generateGenericBody(meta.title, meta.desc, html);
  }
  var md = buildFrontmatter(meta) + body;
  if (jld) {
    if (!md.endsWith('\n')) md += '\n';
    md += '\n```json\n' + jld.raw + '\n```\n';
  }
  return md;
}

var SKIP_DIRS = new Set(['.git', 'node_modules', '.cloudflare', 'scripts']);

function generateMarkdownVersions(distDir) {
  var count = 0;
  function walk(dir) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        var html = fs.readFileSync(fullPath, 'utf8');
        var md   = htmlToMarkdown(html);
        var mdPath = fullPath.slice(0, -5) + '.md';
        fs.writeFileSync(mdPath, md, 'utf8');
        count++;
      }
    }
  }
  walk(distDir);
  console.log('Markdown: generated ' + count + ' .md file(s) alongside HTML.');
  return count;
}

module.exports = { generateMarkdownVersions, htmlToMarkdown };
