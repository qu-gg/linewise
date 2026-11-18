import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Linter } from 'eslint';
import lintConfig from '../eslint.config.mjs';
import { inspectGraph, journalImportViolations, toolPolicyViolations } from './architecture.mjs';

async function fixture(files) {
  const original = process.cwd();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'omp-architecture-'));
  try {
    for (const [file, source] of Object.entries({ 'media/empty.js': '', ...files })) {
      const target = path.join(directory, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    process.chdir(directory);
    return await inspectGraph();
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}

test('architecture accepts metadata-only journal imports and correctly resolves NodeNext TS edges', async () => {
  const report = await fixture({
    'src/state.ts': 'import "./history.js";',
    'src/history.ts': 'export const value = 1;',
  });
  assert.deepEqual(report.summary.violations, []);
  assert.ok(report.modules.some((item) => item.source === 'src/history.ts'));
  assert.deepEqual(
    journalImportViolations('import { lstat, realpath } from "node:fs/promises";'),
    [],
  );
});

test('architecture rejects cycles, browser host access, transport inversions and review coupling', async () => {
  const report = await fixture({
    'src/state.ts': 'import "./history.js";',
    'src/history.ts': 'import "./state.js"; import "./review.js";',
    'src/review.ts': 'import "./extension.js"; import "node:child_process";',
    'src/extension.ts': 'export const value = 1;',
    'media/main.js': 'import "node:fs"; import "../src/extension.js";',
  });
  const rules = new Set(report.summary.violations.map((item) => item.rule.name));
  for (const expected of [
    'no-cycles',
    'webview-not-host',
    'webview-not-core',
    'domain-not-host-or-transport',
    'journal-has-no-concrete-adapters',
    'history-cannot-resolve-reviews',
    'process-creation-is-confined',
  ])
    assert.ok(rules.has(expected), `Missing negative gate: ${expected}`);
});

test('architecture rejects production-to-test dependencies and unresolved imports', async () => {
  const report = await fixture({
    'src/state.ts': 'import "./test/helper.js"; import "./missing.js";',
    'src/test/helper.ts': 'export const value = 1;',
  });
  const rules = report.summary.violations.map((item) => item.rule.name);
  assert.ok(rules.includes('production-not-tests-or-tooling'));
  assert.ok(rules.includes('no-unresolved'));
});

test('journal policies reject direct writes, namespace/default imports and sync escape routes', () => {
  for (const source of [
    'import { writeFile } from "node:fs/promises";',
    'import * as fs from "node:fs/promises";',
    'import fs from "node:fs";',
    'import { unlinkSync } from "node:fs";',
    'import { writeFile } from "fs/promises";',
    'import fs from "fs";',
  ])
    assert.equal(journalImportViolations(source).length, 1);
});

test('tool safety policy cannot silently enable an unmediated mutation tool', () => {
  const safe =
    "const allowedTools = ['read', 'write', 'todo', 'retain', 'recall', 'memory_edit', 'edit', 'bash'];";
  assert.deepEqual(toolPolicyViolations(safe), []);
  assert.equal(toolPolicyViolations(safe.replace("'read'", "'bash'")).length, 1);
  assert.equal(toolPolicyViolations('const allowedTools = otherTools;').length, 1);
});

test('transport stays independent of VS Code and production cannot use dev-only packages', async () => {
  const report = await fixture({
    'package.json': '{"type":"module","devDependencies":{"dev-tool":"1.0.0"}}',
    'node_modules/dev-tool/package.json': '{"name":"dev-tool","version":"1.0.0","main":"index.js"}',
    'node_modules/dev-tool/index.js': 'export const value = 1;',
    'src/acp.ts': 'import "vscode"; import "./workspace.js"; import "dev-tool";',
    'src/workspace.ts': 'export const value = 1;',
  });
  const rules = new Set(report.summary.violations.map((item) => item.rule.name));
  for (const expected of [
    'transport-not-host',
    'vscode-owned-by-host-adapters',
    'production-not-dev-dependencies',
  ])
    assert.ok(rules.has(expected), `Missing negative gate: ${expected}`);
});

test('dynamic-import restriction remains enforced for production but permits test-only loaders', () => {
  const source = 'export async function inspect() { await import("./review.js"); }';
  const production = new Linter().verify(source, lintConfig, { filename: 'src/fixture.ts' });
  const fixture = new Linter().verify(source, lintConfig, { filename: 'src/test/fixture.test.ts' });
  assert.ok(production.some((entry) => entry.ruleId === 'no-restricted-syntax'));
  assert.deepEqual(fixture, []);
});

test('only the terminal adapter gains process ownership, not domains or arbitrary modules', async () => {
  const report = await fixture({
    'src/terminal.ts': 'import "node:child_process";',
    'src/host-tools.ts': 'import "vscode";',
    'src/storage-view.ts': 'import "vscode";',
    'src/host-view.ts': 'import "vscode";',
    'src/host-activation.ts': 'import "vscode";',
    'src/storage.ts': 'import "./host-tools.js"; import "vscode";',
    'src/retention.ts': 'import "./storage-view.js";',
    'src/storage-policy.ts': 'import "./host-activation.js";',
    'src/other.ts': 'import "node:child_process";',
    'src/state.ts': 'import "./terminal.js"; import "./host-tools.js";',
  });
  assert.ok(
    report.summary.violations.some((item) => item.rule.name === 'domain-not-host-or-transport'),
  );
  const processViolations = report.summary.violations.filter(
    (item) => item.rule.name === 'process-creation-is-confined',
  );
  assert.deepEqual(
    processViolations.map((item) => item.from),
    ['src/other.ts'],
  );
  assert.ok(!report.summary.violations.some((item) => item.from === 'src/host-tools.ts'));
  assert.ok(!report.summary.violations.some((item) => item.from === 'src/storage-view.ts'));
  assert.ok(!report.summary.violations.some((item) => item.from === 'src/host-view.ts'));
  assert.ok(!report.summary.violations.some((item) => item.from === 'src/host-activation.ts'));
  for (const source of ['src/retention.ts', 'src/storage-policy.ts'])
    assert.ok(
      report.summary.violations.some(
        (item) => item.from === source && item.rule.name === 'domain-not-host-or-transport',
      ),
    );
  assert.ok(
    report.summary.violations.some(
      (item) => item.from === 'src/storage.ts' && item.rule.name === 'domain-not-host-or-transport',
    ),
  );
  assert.ok(
    report.summary.violations.some(
      (item) =>
        item.from === 'src/storage.ts' && item.rule.name === 'vscode-owned-by-host-adapters',
    ),
  );
});
