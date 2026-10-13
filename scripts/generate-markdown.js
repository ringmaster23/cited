#!/usr/bin/env node
/**
 * generate-markdown.js
 *
 * Generates a .md file alongside every .html file in dist/.
 * Called as part of the build process in build.js.
 *
 * Output format matches the Cloudflare "Markdown for Agents" convention:
 *   1. YAML frontmatter  (title, description, image)
 *   2. Body markdown     (structured from JSON-LD for answer pages; text
 *                         extraction for other pages)
 *   3. JSON-LD block     (fenced ```json … ``` at the end)
 *
 * Answer pages receive full structure: every question, speaker attribution
 * in **Name** (Title, Company): form, the verbatim quote, and a timestamped
 * deep-link to the source recording.  Speaker attribution and source links
 * are the whole point of Cited Conversations, so they are never omitted.
 *
 * All other pages (homepage, answers index, speakers, methodology, …) get:
 *   frontmatter + title heading + description + extracted body text + JSON-LD.
 *
 * No npm dependencies — uses only Node built-ins (fs, path).
 */

'use strict';

var fs   = require('fs');
var path = require('path');

// ── HTML entity decoder ───────────────────────────────────────────────────────

var NAMED_ENTITIES = {
  '&amp;':  '&',
  '&lt;':   '<',
  '&gt;':   '>',
  '&quot;': '"',
  '&#8230;': '\u2026',
  '&#8212;': '\u2014',
  '&#8211;': '\u2013',
  '&#8217;': '\u2019',
  '&#8220;': '\u201C',
  '&#8221;': '\u201D',
  '&nbsp;':  ' ',
  '&ldquo;': '\u201C',
  '&rdquo;': '\u201D',
  '&lsquo;': '\u2018',
  '&rsquo;': '\u2019',
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&hellip;':'\u2026',
};

function decodeHtml(str) {
  if (!str) return '';
  str = str.replace(/&[a-z]+;/g, function(e) {
    return NAMED_ENTITIES[e] !== undefined ? NAMED_ENTITIES[e] : e;
  });
  str = str.replace(/&#(\d+);/g, function(_, n) {
    return String.fromCharCode(parseInt(n, 10));
  });
  return str;
}

// ── YAML value escaping ───────────────────────────────────────────────────────
// Uses double-quoted YAML string only when the value contains characters
// that would break a bare YAML value (colon+space, leading dash, #, etc.).

function yamlValue(val) {
  // If safe as a bare scalar, use it as-is.
  if (!/[:#\[\]{}&*!,|>'"%@`\r\n]/.test(val) && !/^\s/.test(val) && !/\s$/.test(val)) {
    return val;
  }
  return '"' + val.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// ── Meta extraction ───────────────────────────────────────────────────────────

function extractMeta(html) {
  var titleM = html.match(/<title>([^<]*)<\/title>/i);
  var descM  =
    html.match(/name="description"\s+content="([^"]*)"/i)  ||
    html.match(/content="([^"]*)"\s+name="description"/i);
  var imageM =
    html.match(/property="og:image"\s+content="([^"]*)"/i) ||
    html.match(/content="([^"]*)"\s+property="og:image"/i);

  return {
    title: decodeHtml((titleM || [])[1] || ''),
    desc:  decodeHtml((descM  || [])[1] || ''),
    image: (imageM || [])[1] || '',
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

// ── JSON-LD extraction ────────────────────────────────────────────────────────

function extractJsonLd(html) {
  var m = html.match(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return null;
  try {
    return { raw: m[1].trim(), parsed: JSON.parse(m[1]) };
  } catch (_) {
    return { raw: m[1].trim(), parsed: null };
  }
}

// ── Timestamp formatter ───────────────────────────────────────────────────────

function toTimestamp(secs) {
  secs = Math.round(secs);
  var mm = Math.floor(secs / 60);
  var ss = String(secs % 60).padStart('00', 2);
  if (ss.length < 2) ss = '0' + ss;
  return mm + ':' + ss;
}

// Polyfill for String.prototype.padStart (Node 14 compat)
function padStart(str, fill, len) {
  str = String(str);
  while (str.length < len) str = fill + str;
  return str;
}

function fmt(secs) {
  secs = Math.round(secs);
  var mm = String(Math.floor(secs / 60));
  var ss = padStart(String(secs % 60), '0', 2);
  return mm + ':' + ss;
}

// ── Text cleanup ──────────────────────────────────────────────────────────────

// The JSON-LD "text" fields use "& " as a paragraph separator (from the
// VTT source).  Convert to an actual paragraph break.
function cleanQuoteText(raw) {
  if (!raw) return '';
  var s = decodeHtml(raw);
  // Replace "& " paragraph markers with a blank line
  s = s.replace(/\s*&\s+/g, '\n>\n> ');
  // Collapse any remaining double spaces
  s = s.replace(/  +/g, ' ').trim();
  return s;
}

// ── Answer-page markdown ──────────────────────────────────────────────────────

function generateAnswerPageBody(title, desc, graph) {
  var lines = [];

  lines.push('# ' + title, '');
  if (desc) { lines.push(desc, ''); }

  // Build lookup maps from the @graph array
  var episode  = null;
  var audio    = null;
  var persons  = {};
  var clips    = [];
  var quotations = [];

  for (var i = 0; i < graph.length; i++) {
    var node = graph[i];
    var t = node['@type'];
    if (t === 'PodcastEpisode') { episode = node; continue; }
    if (t === 'AudioObject')    { audio   = node; continue; }
    if (t === 'Person')         { if (node['@id']) persons[node['@id']] = node; continue; }
    if (t === 'Clip')           { clips.push(node);       continue; }
    if (t === 'Quotation')      { quotations.push(node);  continue; }
  }

  // Episode provenance block
  if (audio && audio.embedUrl) {
    lines.push('**Episode:** [Listen on podcast](' + audio.embedUrl + ')', '');
  }
  if (episode) {
    if (episode.datePublished) {
      lines.push('**Published:** ' + episode.datePublished.split('T')[0], '');
    }
    if (episode.description) {
      lines.push(episode.description, '');
    }
  }
  lines.push('---', '');

  // One block per clip, paired with the matching quotation (same index)
  for (var ci = 0; ci < clips.length; ci++) {
    var clip = clips[ci];
    var quot = quotations[ci] || null;

    // Question label: Q1, Q2, … extracted from the @id fragment
    var qNumM = (clip['@id'] || '').match(/#(q\d+)-clip/i);
    var qLabel = qNumM ? qNumM[1].toUpperCase() : ('Q' + (ci + 1));

    lines.push('## ' + qLabel + ': ' + clip.name, '');

    if (quot) {
      // Speaker attribution
      var speakerId = quot.spokenByCharacter && quot.spokenByCharacter['@id'];
      if (speakerId && persons[speakerId]) {
        var p = persons[speakerId];
        var orgName = p.worksFor ? p.worksFor.name : '';
        var roleParts = [p.jobTitle, orgName].filter(Boolean).join(', ');
        lines.push(
          '**' + p.name + '**' + (roleParts ? ' (' + roleParts + ')' : '') + ':',
          ''
        );
      }

      // Verbatim quote — preserves speaker's words exactly
      var qText = cleanQuoteText(quot.text || '');
      if (qText) {
        // Blockquote — each line gets >
        var qLines = qText.split('\n');
        for (var qi = 0; qi < qLines.length; qi++) {
          lines.push('> ' + qLines[qi]);
        }
        lines.push('');
      }

      // Timestamped source link
      var citationUrl = quot.citation || (clip.url || '');
      if (citationUrl) {
        var tsM = citationUrl.match(/[?&]t=(\d+)/);
        var label = tsM ? '\u25B6 Listen at ' + fmt(+tsM[1]) : '\u25B6 Listen';
        lines.push('[' + label + '](' + citationUrl + ')', '');
      }
    } else if (clip.url) {
      var tsM2 = clip.url.match(/[?&]t=(\d+)/);
      var label2 = tsM2 ? '\u25B6 Listen at ' + fmt(+tsM2[1]) : '\u25B6 Listen';
      lines.push('[' + label2 + '](' + clip.url + ')', '');
    }

    lines.push('---', '');
  }

  return lines.join('\n');
}

// ── Generic page markdown ─────────────────────────────────────────────────────
// Used for homepage, answers index, speaker pages, methodology, stats, etc.

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ')
             .replace(/\s+/g, ' ')
             .trim();
}

// Extract a rough plain-text body from a section of HTML.
// Limits to ~2000 chars so the markdown doesn't bloat.
function extractBodyText(html) {
  // Prefer <main> content; fall back to everything between <body> tags.
  var bodyM = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
              html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyM) return '';
  // Strip scripts, styles, nav, header, footer, aside
  var cleaned = bodyM[1]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');
  var text = decodeHtml(stripTags(cleaned));
  // Trim and cap
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 2500) text = text.slice(0, 2500) + ' …';
  return text;
}

function generateGenericBody(title, desc, html) {
  var lines = [];
  lines.push('# ' + title, '');
  if (desc) { lines.push(desc, ''); }
  var body = extractBodyText(html);
  if (body && body.length > 60) {
    lines.push(body, '');
  }
  return lines.join('\n');
}

// ── Speaker page markdown ─────────────────────────────────────────────────────

function generateSpeakerBody(title, desc, graph) {
  var lines = [];
  lines.push('# ' + title, '');
  if (desc) { lines.push(desc, ''); }

  var person = null;
  for (var i = 0; i < graph.length; i++) {
    if (graph[i]['@type'] === 'Person') { person = graph[i]; break; }
  }

  if (person) {
    if (person.jobTitle) { lines.push('**Title:** ' + person.jobTitle, ''); }
    if (person.worksFor && person.worksFor.name) {
      lines.push('**Organization:** ' + person.worksFor.name, '');
    }
    if (person.description) { lines.push(person.description, ''); }
    if (person.sameAs && person.sameAs.length) {
      lines.push('**Links:** ' + person.sameAs.join(' · '), '');
    }
  }

  return lines.join('\n');
}

// ── Top-level converter ───────────────────────────────────────────────────────

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
      body = generateAnswerPageBody(meta.title, meta.desc, graph);
    } else if (hasPerson && !hasClips) {
      body = generateSpeakerBody(meta.title, meta.desc, graph);
    } else {
      body = generateGenericBody(meta.title, meta.desc, html);
    }
  } else {
    body = generateGenericBody(meta.title, meta.desc, html);
  }

  var md = buildFrontmatter(meta) + body;

  // Append JSON-LD fenced block (Cloudflare convention)
  if (jld) {
    if (!md.endsWith('\n')) md += '\n';
    md += '\n```json\n' + jld.raw + '\n```\n';
  }

  return md;
}

// ── File walker ───────────────────────────────────────────────────────────────

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
        var mdPath = fullPath.slice(0, -5) + '.md'; // replace .html with .md
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
