import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

async function ready<Value>(pending: PromiseLike<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Provider activation exceeded the probe budget.')),
          40000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function run(): Promise<void> {
  const report = process.env.VS_OMP_TEST_PROVIDER_REPORT;
  assert.ok(report);
  const present = process.env.VS_OMP_TEST_PROVIDER_PRESENT === '1';
  const namespace = Object.keys(vscode.tests).sort();
  const stable: unknown = JSON.parse(process.env.VS_OMP_STABLE_TEST_API ?? 'null');
  assert.deepEqual(stable, ['createTestController']);
  assert.equal(typeof vscode.tests.createTestController, 'function');
  const provider = vscode.extensions.getExtension('ms-python.python');
  assert.equal(!!provider, present);
  let exportNames: string[] = [];
  if (provider) {
    assert.equal(provider.packageJSON.version, '2026.10.0');
    const api: unknown = await ready(provider.activate());
    assert.ok(api && typeof api === 'object');
    const descriptors = Object.getOwnPropertyDescriptors(api);
    exportNames = Object.keys(descriptors).sort();
    if (descriptors.ready?.value instanceof Promise) await ready(descriptors.ready.value);
    assert.ok(exportNames.includes('debug'));
    assert.ok(exportNames.includes('environments'));
    assert.equal(
      exportNames.some((name) =>
        /^(testing|tests|testController|discoverTests|runTests|cancelTests)$/i.test(name),
      ),
      false,
    );
  }
  await writeFile(
    report,
    JSON.stringify(
      {
        passed: true,
        outcome: present
          ? 'unavailable-no-documented-provider-bridge'
          : 'unavailable-provider-absent',
        vscodeVersion: vscode.version,
        stableTestNamespace: stable,
        runtimeTestNamespace: namespace,
        proposedTestApiInvocations: 0,
        proposedApiBoundary:
          'Other runtime testing members require testObserver in the pinned public implementation; enumeration is not stable access.',
        provider: present
          ? { id: 'ms-python.python', version: '2026.10.0', activated: true, exportNames }
          : null,
        createdFixtureControllers: 0,
        providerTestRuns: 0,
        invokedProviderCommands: 0,
        accessedPrivateProviderValues: false,
        probeModelRequests: 0,
        scope:
          'export-inventory-only; no cross-extension discovery, run, result or cancellation bridge accepted',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    'PASS: stable testing namespace and disposable real-provider exports inspected without test execution or private API use.',
  );
}
