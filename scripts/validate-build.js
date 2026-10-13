#!/usr/bin/env node
/**
 * validate-build.js
 * 
 * Pre-deploy validation for citedconversations.com.
 * Run: node scripts/validate-build.js
 * Exit 0 = all clear. Exit 1 = one or more failures.
 *
 * Checks every .html file in the repo for:
 *   1. Unclosed <script> tag (more opens than closes)
 *   2. Missing </head>
 *   3. Missing <body>
 *   4. Invalid JSON-LD (malformed JSON inside <script type="application/ld+json">)
 *   5. Missing </body> and </html>
 *
 * Root cause of the Oct 2026 blank-page bug:
 *   The answer page builder accidentally included HTML closing tags (</p>) inside
 *   JSON-LD "text" string values and then dropped the remaining JSON-LD entries,
 *   </script>, </head>, and <body>. This caused browsers to treat the entire page
 *   body as script content and render nothing. This check would have caught that
 *   before deploy.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

// Directories to skip entirely (node_modules, .git, etc.)
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cloudflare', 'scripts']);

// ── Helpers ──────────────────────────────────────────────────────────────────

function findHtml(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findHtml(path.join(dir, entry.name), results);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function checkFile(filePath) {
  const rel  = path.relative(ROOT, filePath);
  const src  = fs.readFileSync(filePath, 'utf8');
  const errs = [];

  // 1. Script tag balance
  const scriptOpens  = (src.match(/<script[\s>]/gi)  || []).length;
  const scriptCloses = (src.match(/<\/script>/gi) || []).length;
  if (scriptOpens !== scriptCloses) {
    errs.push(`UNCLOSED_SCRIPT: ${scriptOpens} opens vs ${scriptCloses} closes`);
  }

  // 2. </head> present
  if (!src.includes('</head>')) {
    errs.push('MISSING_HEAD_CLOSE: no </head> found');
  }

  // 3. <body> present
  if (!/<body[\s>]/i.test(src)) {
    errs.push('MISSING_BODY_OPEN: no <body> tag found');
  }

  // 4. </body> and </html> present
  if (!src.includes('</body>')) errs.push('MISSING_BODY_CLOSE: no </body> found');
  if (!src.includes('</html>')) errs.push('MISSING_HTML_CLOSE: no </html> found');

  // 5. JSON-LD validity
  const ldPattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let ldIdx = 0;
  while ((m = ldPattern.exec(src)) !== null) {
    ldIdx++;
    try {
      JSON.parse(m[1]);
    } catch (e) {
      errs.push(`INVALID_JSON_LD[${ldIdx}]: ${e.message.split('\n')[0]}`);
    }
  }
  if (ldIdx === 0 && src.includes('ld+json')) {
    errs.push('MISSING_JSON_LD_CLOSE: ld+json script found but regex could not extract it — likely unclosed <script>');
  }

  return { rel, errs };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const htmlFiles = findHtml(ROOT);
let failures = 0;

for (const f of htmlFiles) {
  const { rel, errs } = checkFile(f);
  if (errs.length > 0) {
    console.error(`\nFAIL  ${rel}`);
    for (const e of errs) console.error(`      • ${e}`);
    failures++;
  } else {
    console.log(`OK    ${rel}`);
  }
}

console.log(`\n──────────────────────────────────────────────`);
console.log(`Checked ${htmlFiles.length} HTML file(s). Failures: ${failures}`);

if (failures > 0) {
  console.error('\nBuild validation FAILED — do not deploy.');
  process.exit(1);
} else {
  console.log('Build validation passed.');
  process.exit(0);
}
