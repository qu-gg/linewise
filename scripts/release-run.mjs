import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function validateRun(run, repository, commit) {
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, commit);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.actor.login, repository.split('/')[0]);
}

function api(endpoint) {
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'GitHub release preflight API failed');
  return JSON.parse(result.stdout);
}

async function main() {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: commit,
    CANDIDATE_RUN: runId,
    ACCEPTANCE_JSON: acceptance,
  } = process.env;
  assert.equal(repository, 'qu-gg/vs-omp');
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.match(runId, /^[1-9]\d*$/);
  assert.ok(acceptance && acceptance.length <= 4096, 'Provide bounded local acceptance JSON');
  const repo = api(`repos/${repository}`);
  assert.equal(repo.private, true);
  assert.equal(repo.default_branch, 'main');
  assert.equal(api(`repos/${repository}/branches/main`).commit.sha, commit);
  validateRun(api(`repos/${repository}/actions/runs/${runId}`), repository, commit);
  const artifacts = api(`repos/${repository}/actions/runs/${runId}/artifacts`).artifacts;
  const candidates = artifacts.filter(
    (artifact) => artifact.name === 'release-candidate' && !artifact.expired,
  );
  assert.equal(candidates.length, 1, 'Expected one unexpired candidate artifact');
  await writeFile(
    'reports/release-acceptance.json',
    `${JSON.stringify(JSON.parse(acceptance), null, 2)}\n`,
    { flag: 'wx' },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
