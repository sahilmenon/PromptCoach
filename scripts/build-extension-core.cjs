#!/usr/bin/env node
/**
 * Generate extension/lib/promptcoach-core.js from src/shared/core.ts.
 *
 * The extension has no bundler, so the shared core is transpiled to a plain
 * script that exposes a single `PromptCoachCore` global. The generated file is
 * committed so "Load unpacked" works straight from a clone; run this script
 * (or `npm run build`) after editing src/shared/core.ts.
 *
 * `--check` verifies the committed bundle matches the source without writing
 * (used by `npm run extension:check` and tests/sharedCore.test.ts).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'src', 'shared', 'core.ts');
const outPath = path.join(root, 'extension', 'lib', 'promptcoach-core.js');
const tscBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

function generate() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcoach-core-'));
  try {
    const result = spawnSync(
      tscBin,
      [
        sourcePath,
        // Skip tsconfig.json: it targets the whole CLI build, this is one file.
        '--ignoreConfig',
        '--module', 'commonjs',
        '--target', 'es2020',
        '--outDir', tmpDir,
      ],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      throw new Error('tsc failed:\n' + (result.stdout || '') + (result.stderr || ''));
    }
    const transpiled = fs.readFileSync(path.join(tmpDir, 'core.js'), 'utf8');
    return [
      '// GENERATED FILE — DO NOT EDIT.',
      '// Source of truth: src/shared/core.ts (shared by the CLI and this extension).',
      '// Regenerate with: npm run build:extension-core',
      'var PromptCoachCore = (function () {',
      '  var exports = {};',
      '  var module = { exports: exports };',
      transpiled.replace(/^/gm, '  ').replace(/[ \t]+$/gm, ''),
      '  return module.exports;',
      '})();',
      "if (typeof globalThis !== 'undefined') { globalThis.PromptCoachCore = PromptCoachCore; }",
      '',
    ].join('\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const output = generate();
if (process.argv.includes('--check')) {
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (existing !== output) {
    console.error('extension/lib/promptcoach-core.js is out of sync with src/shared/core.ts.');
    console.error('Run: npm run build:extension-core');
    process.exit(1);
  }
  console.log('extension core bundle is in sync.');
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output);
  console.log('Wrote ' + path.relative(root, outPath));
}
