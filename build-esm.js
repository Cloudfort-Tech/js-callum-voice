/**
 * Post-build script: rename dist-esm/*.js → dist/*.mjs
 * Run after `tsc` (CJS) to produce the ESM bundle.
 */
const fs = require('fs');
const path = require('path');

const esmDir = path.join(__dirname, 'dist-esm');
const distDir = path.join(__dirname, 'dist');

if (!fs.existsSync(esmDir)) {
  console.error('dist-esm directory not found. Run `tsc -p tsconfig.esm.json` first.');
  process.exit(1);
}

const files = fs.readdirSync(esmDir).filter(f => f.endsWith('.js'));
for (const file of files) {
  const src = path.join(esmDir, file);
  const dest = path.join(distDir, file.replace(/\.js$/, '.mjs'));
  fs.copyFileSync(src, dest);
  console.log(`  ${file} → ${path.basename(dest)}`);
}

// Cleanup temp directory
fs.rmSync(esmDir, { recursive: true, force: true });
console.log('ESM build complete.');
