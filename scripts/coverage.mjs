import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './quality.mjs';
import { digest, sourceManifest } from '../quality/files.mjs';
import { retainAnonymousFunctions } from '../quality/coverage.mjs';

const sources = sourceManifest();
rmSync('.quality-build', { recursive: true, force: true });
rmSync('reports/coverage', { recursive: true, force: true });
run('node_modules/typescript-compiler/bin/tsc', ['-p', '.', '--outDir', '.quality-build']);
const tests = readdirSync('.quality-build/test')
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => path.join('.quality-build/test', file));
if (!tests.length) throw new Error('No deterministic tests were discovered.');
run('node_modules/c8/bin/c8.js', ['--reporter=json', process.execPath, '--test', ...tests]);
const roots = ['.quality-build/', 'media/'].map(
  (root) => pathToFileURL(path.resolve(root) + path.sep).href,
);
for (const file of readdirSync('reports/coverage/tmp').filter((file) => file.endsWith('.json'))) {
  const target = path.join('reports/coverage/tmp', file);
  const raw = JSON.parse(readFileSync(target, 'utf8'));
  writeFileSync(target, JSON.stringify(retainAnonymousFunctions(raw, roots)));
}
run('node_modules/c8/bin/c8.js', ['report']);
if (JSON.stringify(sources) !== JSON.stringify(sourceManifest()))
  throw new Error('Production sources changed during coverage collection.');
writeFileSync(
  'reports/coverage/manifest.json',
  JSON.stringify(
    {
      version: 1,
      profile: 'unit',
      sources,
      coverageHash: digest(readFileSync('reports/coverage/coverage-final.json')),
    },
    null,
    2,
  ) + '\n',
);
