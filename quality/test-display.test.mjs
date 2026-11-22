import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayEnvironment,
  displayMode,
  findDisplayTool,
  windowManagerEnvironment,
} from '../scripts/test-display.mjs';

test('Linux GUI tests default to quiet with explicit visible opt-in and no typo fallback', () => {
  assert.equal(displayMode({}, 'linux'), 'quiet');
  assert.equal(displayMode({ VS_OMP_TEST_DISPLAY: 'visible' }, 'linux'), 'visible');
  assert.equal(displayMode({}, 'darwin'), 'visible');
  assert.throws(() => displayMode({ VS_OMP_TEST_DISPLAY: 'quite' }, 'linux'), /Invalid/);
  assert.throws(() => displayMode({ VS_OMP_TEST_DISPLAY: 'quiet' }, 'darwin'), /only on Linux/);
});

test('quiet GUI environment removes real desktop endpoints without changing inference settings', () => {
  const env = {
    PATH: '/custom/bin',
    HOME: '/fixture-home',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XAUTHORITY: '/user/auth',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/user/bus',
    DBUS_STARTER_ADDRESS: 'user-starter',
    SESSION_MANAGER: 'user-manager',
    DESKTOP_STARTUP_ID: 'user-startup',
    VS_OMP_LIVE_TESTS: '0',
  };
  const isolated = displayEnvironment(env, { Xvfb: '/fixture/usr/bin/Xvfb' });
  for (const key of [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'DBUS_STARTER_ADDRESS',
    'SESSION_MANAGER',
    'DESKTOP_STARTUP_ID',
  ]) {
    assert.equal(isolated[key], undefined);
  }
  assert.equal(isolated.HOME, env.HOME);
  assert.equal(isolated.VS_OMP_LIVE_TESTS, '0');
  assert.equal(isolated.VS_OMP_TEST_DISPLAY_ACTIVE, '1');
  assert.equal(isolated.PATH, '/fixture/usr/bin:/usr/bin:/custom/bin');
  assert.equal(env.DISPLAY, ':0');
  assert.equal(windowManagerEnvironment(env).HOME, env.HOME);
});

test('missing virtual-display prerequisites fail clearly without a visible fallback', () => {
  assert.throws(() => findDisplayTool('Xvfb', ''), /Missing Xvfb.*No visible fallback/);
  assert.throws(() => findDisplayTool('openbox', '/dev/null'), /Missing openbox/);
  assert.equal(findDisplayTool('true', '/dev/null:/usr/bin'), '/usr/bin/true');
});
