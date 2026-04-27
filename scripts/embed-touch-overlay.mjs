// Embed js/touch-overlay.js as a string constant in workers/groq-proxy.js
// so the worker can inline it into proxied HTML responses.
//
// Run after editing js/touch-overlay.js, then redeploy the worker.
//   node scripts/embed-touch-overlay.mjs

import fs from 'node:fs';

const workerPath = 'workers/groq-proxy.js';
const scriptPath = 'js/touch-overlay.js';

let worker = fs.readFileSync(workerPath, 'utf8');
const script = fs.readFileSync(scriptPath, 'utf8');

// Lightly clean: strip top-level comments + collapse multi-blank lines.
// We want the source readable enough that a worker reviewer can scan
// what's running, but small enough to stay well under Cloudflare's
// 1MB worker size limit.
const minified = script
    .replace(/^\s*\/\/[^\n]*$/gm, '') // line comments
    .replace(/\n\s*\n+/g, '\n')        // collapse blank lines
    .trim();

// String.raw + backtick-template prevents most escape issues. Escape
// any backticks or ${} in the source so the template doesn't break.
const safe = minified
    .replace(/\\/g, '\\\\')   // escape any literal backslashes
    .replace(/`/g, '\\`')     // escape backticks
    .replace(/\$\{/g, '\\${'); // escape ${ to avoid template eval

const constDecl = 'const TOUCH_OVERLAY_SCRIPT = `' + safe + '`;\n\n';

const marker = 'export default {';
if (!worker.includes(marker)) {
    console.error('Could not find "export default {" in worker');
    process.exit(1);
}

const existingRe = /const TOUCH_OVERLAY_SCRIPT = `[\s\S]*?`;\s*\n\s*\n/;
if (existingRe.test(worker)) {
    worker = worker.replace(existingRe, constDecl);
} else {
    worker = worker.replace(marker, constDecl + marker);
}

fs.writeFileSync(workerPath, worker);
console.log(`Embedded TOUCH_OVERLAY_SCRIPT in ${workerPath} (${safe.length} chars from ${script.length} source).`);
