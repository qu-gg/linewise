import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { profile, validateAcceptance, verifyDirectory } from './release.mjs';
import { validateMaintainer } from './release-run.mjs';

export function acceptanceArguments(args) {
  const [directory, output, manual, rollback] = args;
  assert.ok(
    directory && output,
    'Usage: release:accept -- CANDIDATE_DIRECTORY OUTPUT_JSON --manual-smoke-passed --rollback=passed|unavailable-first-release',
  );
  assert.equal(args.length, 4);
  assert.equal(manual, '--manual-smoke-passed');
  assert.ok(['--rollback=passed', '--rollback=unavailable-first-release'].includes(rollback));
  assert.ok(
    !path.resolve(output).startsWith(`${path.resolve(directory)}${path.sep}`),
    'Keep acceptance outside the candidate directory',
  );
  return { directory, output, rollback: rollback.slice('--rollback='.length) };
}

export function validateRuntimeVersions(vscode, omp) {
  assert.equal(vscode, '1.146.0');
  assert.equal(omp, 'omp/18.21.0');
  return { vscode, omp: '18.21.0' };
}

function execute(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `Release acceptance command failed: ${command}`);
  return result.stdout.trim();
}

function nodeGate(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  assert.equal(result.status, 0, 'Release acceptance gate failed; no attestation written');
}

function cleanCommit() {
  assert.equal(
    execute('git', ['status', '--porcelain=v1']),
    '',
    'Accept only a clean committed checkout',
  );
  return execute('git', ['rev-parse', 'HEAD']);
}

async function main() {
  const options = acceptanceArguments(process.argv.slice(2));
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const commit = cleanCommit();
  const candidate = await verifyDirectory(options.directory, commit);
  const vscode = process.env.VSCODE_EXECUTABLE || '/usr/share/code/bin/code';
  const vscodeVersion = execute(vscode, ['--version'], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
  }).split('\n')[0];
  const versions = validateRuntimeVersions(vscodeVersion, execute('omp', ['--version']));
  execute('npm', ['audit', '--audit-level=moderate']);
  nodeGate(['scripts/quality.mjs', 'release']);
  nodeGate(['scripts/test-extension.mjs'], {
    ...process.env,
    VS_OMP_VSIX: path.resolve(options.directory, candidate.package.file),
  });
  assert.equal(cleanCommit(), commit);
  await verifyDirectory(options.directory, commit);
  const owner = execute('gh', ['api', 'user', '--jq', '.login']);
  validateMaintainer(owner);
  const acceptance = {
    schema: 1,
    commit,
    sha256: candidate.package.sha256,
    profile,
    platform: process.platform,
    arch: process.arch,
    omp: versions.omp,
    vscode: versions.vscode,
    owner,
    native: true,
    packaged: true,
    manualSmoke: true,
    scopeExclusionsAcknowledged: true,
    rollback: options.rollback,
  };
  validateAcceptance(acceptance, candidate);
  await writeFile(options.output, `${JSON.stringify(acceptance, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(`Local acceptance recorded: ${options.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
