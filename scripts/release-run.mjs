import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const releasePolicy = JSON.parse(
  readFileSync(new URL('../.github/release-maintainers.json', import.meta.url), 'utf8'),
);

export function validateMaintainer(login, policy = releasePolicy) {
  assert.ok(policy.maintainers.includes(login), 'Release requires an approved maintainer');
}

export function validateDestination(repo, repository, commit, current, visibility) {
  assert.equal(repository, releasePolicy.repository);
  assert.equal(repo.full_name, repository);
  assert.ok(['private', 'public'].includes(visibility), 'Choose release destination visibility');
  assert.equal(repo.private, visibility === 'private', 'Repository visibility changed');
  assert.equal(repo.default_branch, 'main');
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(current, commit, 'Release requires the current main commit');
}

export function validateRun(run, repository, commit) {
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, commit);
  assert.equal(run.head_repository.full_name, repository);
  validateMaintainer(run.actor.login);
}

function api(endpoint) {
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'GitHub release preflight API failed');
  return JSON.parse(result.stdout);
}

function authorize(repository, commit, visibility) {
  validateDestination(
    api(`repos/${repository}`),
    repository,
    commit,
    api(`repos/${repository}/branches/main`).commit.sha,
    visibility,
  );
  const actor = process.env.GITHUB_ACTOR;
  validateMaintainer(actor);
  const permission = api(`repos/${repository}/collaborators/${actor}/permission`).permission;
  assert.ok(['admin', 'maintain'].includes(permission), 'Maintainer permission is required');
}

async function main() {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: commit,
    CANDIDATE_RUN: runId,
    ACCEPTANCE_JSON: acceptance,
    RELEASE_VISIBILITY: visibility,
  } = process.env;
  authorize(repository, commit, visibility);
  if (process.argv[2] === 'authorize') {
    assert.ok(process.env.GITHUB_OUTPUT);
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `allowed=true\nprivate=${visibility === 'private'}\n`,
    );
    return;
  }
  assert.match(runId, /^[1-9]\d*$/);
  assert.ok(acceptance && acceptance.length <= 4096, 'Provide bounded local acceptance JSON');
  validateRun(api(`repos/${repository}/actions/runs/${runId}`), repository, commit);
  const artifacts = api(`repos/${repository}/actions/runs/${runId}/artifacts`).artifacts;
  const candidates = artifacts.filter(
    (artifact) => artifact.name === 'release-candidate' && !artifact.expired,
  );
  assert.equal(candidates.length, 1, 'Expected one unexpired candidate artifact');
  await writeFile(
    'reports/release-acceptance.json',
    `${JSON.stringify(JSON.parse(acceptance), null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
