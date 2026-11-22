import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayTools, windowManagerEnvironment } from './test-display.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The local display bootstrap currently supports Debian/Ubuntu Linux x64 only.');
}

const directory = fileURLToPath(new URL('../.local-dev/test-display/', import.meta.url));
const archives = path.join(directory, 'archives');
await mkdir(archives, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed (${result.status ?? result.signal}).`);
  return result.stdout;
}

command('/usr/bin/apt-get', [
  '--download-only',
  '--yes',
  '--no-install-recommends',
  '-o',
  `Dir::Cache=${directory}`,
  '-o',
  `Dir::Cache::archives=${archives}`,
  '-o',
  `Dir::State::extended_states=${path.join(directory, 'extended_states')}`,
  '-o',
  `Dir::Log=${directory}`,
  '-o',
  'Debug::NoLocking=true',
  '-o',
  `APT::Sandbox::User=${userInfo().username}`,
  'install',
  'xvfb',
  'openbox',
  'dbus-daemon',
  'xauth',
  'wmctrl',
  'x11-utils',
  'fonts-dejavu-core',
]);

const inventory = [];
const files = await readdir(archives);
for (const name of files.filter((file) => file.endsWith('.deb')).sort()) {
  const archive = path.join(archives, name);
  command('/usr/bin/dpkg-deb', ['--extract', archive, directory]);
  const identity = command(
    '/usr/bin/dpkg-deb',
    ['--show', '--showformat=${Package}\t${Version}\t${Architecture}', archive],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  inventory.push({
    identity,
    archive: name,
    sha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
  });
}

const tools = displayTools();
command(tools.Xvfb, ['-help'], { stdio: 'pipe' });
command(tools.openbox, ['--version'], { env: windowManagerEnvironment() });
command(tools['dbus-run-session'], ['--version']);
await writeFile(
  path.join(directory, 'packages.json'),
  `${JSON.stringify({ packages: inventory, tools, systemInstall: false }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`Quiet display dependencies ready in ${directory}. No system packages installed.`);
