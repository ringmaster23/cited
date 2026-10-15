#!/usr/bin/env node
/**
 * validate-build.js
 *
 * Pre-deploy HTML structure check for citedconversations.com.
 * Run: node scripts/validate-build.js
 * Exit 0 = all clear. Exit 1 = one or more failures.
 *
 * Checks every .html file in the repo for:
 * 1. Mismatched <script> / </script> tags
 * 2. Missing </head>
 * 3. Missing <body>
 * 4. Missing </body> or </html>
 * 5. Invalid JSON-LD (malformed JSON inside a ld+json block)
 *
 * Also writes dist/build-report.json (or ./build-report.json if dist/ does not exist)
 * so a downstream process can read the findings and post them to Slack.
 *
 * Root cause of the Oct 2026 blank-page bug:
 * The answer page builder accidentally included HTML closing tags (</script>) inside
 * JSON-LD "text" string values. This caused browsers to treat the entire page body as
 * script content and render nothing. This check catches that before deploy.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');

// Directories to skip entirely
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cloudflare', 'scripts']);

// ── Report ────────────────────────────────────────────────────────────────────

const REPORT = {
  timestamp: new Date().toISOString(),
  tool: 'validate-build',
  status: 'passed',
  errors: []
};

function addReportError(file, checks) {
  REPORT.status = 'failed';
  REPORT.errors.push({ file: file, checks: checks });
}

function writeReport() {
  var distDir  = path.join(ROOT, 'dist');
  var outDir   = fs.existsSync(distDir) ? distDir : ROOT;
  var outPath  = path.join(outDir, 'build-report.json');
  try {
    fs.writeFileSync(outPath, JSON.stringify(REPORT, null, 2), 'utf8');
    console.error('  → Report written to ' + path.relative(ROOT, outPath));
  } catch (e) {
    console.error('  (Could not write build-report.json: ' + e.message + ')');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findHtml(dir, results) {
  results = results || [];
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
  const rel = path.relative(ROOT, filePath);
  const src = fs.readFileSync(filePath, 'utf8');
  const errs = [];

  // 1. <script> tag balance
  const scriptOpens  = (src.match(/<script[\s>]/gi) || []).length;
  const scriptCloses = (src.match(/<\/script>/gi)   || []).length;
  if (scriptOpens !== scriptCloses) {
    errs.push(
      'Mismatched <script> tags: ' + scriptOpens + ' opening tag' +
      (scriptOpens === 1 ? '' : 's') + ' but ' + scriptCloses + ' closing </script> tag' +
      (scriptCloses === 1 ? '' : 's') + '. ' +
      'This usually means a </script> tag ended up inside a JSON-LD string — ' +
      'check every application/ld+json block for an unescaped </script>.'
    );
  }

  // 2. </head> present
  if (!src.includes('</head>')) {
    errs.push(
      'The page is missing its </head> closing tag. ' +
      'This can prevent stylesheets and scripts from loading.'
    );
  }

  // 3. <body> present
  if (!/<body[\s>]/i.test(src)) {
    errs.push(
      'The page is missing its <body> opening tag. ' +
      'Browsers may refuse to render anything.'
    );
  }

  // 4. </body> and </html> present
  if (!src.includes('</body>')) {
    errs.push(
      'The page is missing its </body> closing tag. ' +
      'Some browsers may drop content that appears after the open body area.'
    );
  }
  if (!src.includes('</html>')) {
    errs.push(
      'The page is missing its </html> closing tag.'
    );
  }

  // 5. JSON-LD validity
  const ldPattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let ldIdx = 0;
  while ((m = ldPattern.exec(src)) !== null) {
    ldIdx++;
    try {
      JSON.parse(m[1]);
    } catch (e) {
      errs.push(
        'The JSON-LD block #' + ldIdx + ' contains invalid JSON: ' +
        e.message.split('\n')[0] + '. ' +
        'Open the page source and find the <script type="application/ld+json"> block — ' +
        'look for an unescaped quote, bracket, or stray HTML tag inside the JSON string.'
      );
    }
  }
  if (ldIdx === 0 && src.includes('ld+json')) {
    errs.push(
      'A JSON-LD block was found in the source but the closing </script> tag is missing or malformed. ' +
      'The regex could not extract the block — check for an unescaped </script> inside the JSON string.'
    );
  }

  return { rel, errs };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const htmlFiles = findHtml(ROOT);
let failures = 0;

for (const f of htmlFiles) {
  const { rel, errs } = checkFile(f);
  if (errs.length > 0) {
    console.error('\n✗ ' + rel);
    for (const e of errs) console.error('  • ' + e);
    addReportError(rel, errs);
    failures++;
  } else {
    console.log('OK ' + rel);
  }
}

console.log('\n' + '─'.repeat(60));
console.log('Checked ' + htmlFiles.length + ' HTML file' + (htmlFiles.length === 1 ? '' : 's') + '. Failures: ' + failures);

if (failures > 0) {
  console.error('\n✗ BUILD VALIDATION FAILED — fix the ' + failures + ' file' + (failures === 1 ? '' : 's') + ' listed above before deploying.');
  writeReport();
  process.exit(1);
} else {
  REPORT.status = 'passed';
  writeReport();
  console.log('Build validation passed.');
  process.exit(0);
}
