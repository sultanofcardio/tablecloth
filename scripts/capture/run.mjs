// README screenshot rig: seeds a profile, launches a capture VS Code via
// @vscode/test-electron, and shoots each surface when the in-host suite drops
// its marker. Requires the seeded Postgres from scripts/capture/seed.sql and
// the venv python with pyobjc (VENV_PY env or default scratch path).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = process.env.SHOT_DIR ?? join(root, 'scripts', 'capture', 'out');
// which in-host suite to run and which markers it drops (README shots by default);
// SHOT_NAMES narrows the list, otherwise every marker the suite drops is shot
const suiteFile = process.env.SHOT_SUITE ?? 'suite.cjs';
const suiteShots = {
  'suite.cjs': 'hero,grid,dialog',
  'phase2.cjs': 'grid-changes,grid-submit,grid-filter,grid-transposed,console-inspections,console-parameters,import',
};
const shotNames = (process.env.SHOT_NAMES ?? suiteShots[suiteFile] ?? '').split(',').filter(Boolean);
if (shotNames.length === 0) throw new Error(`set SHOT_NAMES: no known shots for ${suiteFile}`);
const venvPython = process.env.VENV_PY;
if (!venvPython) throw new Error('set VENV_PY to the pyobjc venv python');

delete process.env.ELECTRON_RUN_AS_NODE;

const work = mkdtempSync(join(tmpdir(), 'tablecloth-shot-'));
const profile = join(work, 'profile');
const markerDir = join(work, 'markers');
const workspace = join(work, 'ws');
mkdirSync(join(profile, 'User'), { recursive: true });
mkdirSync(markerDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(profile, 'User', 'settings.json'),
  JSON.stringify(
    {
      'workbench.colorTheme': 'Default Dark Modern',
      'breadcrumbs.enabled': false,
      'workbench.startupEditor': 'none',
      'window.commandCenter': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'tablecloth.dataSources': [
        {
          id: 'shot-acme',
          name: 'acme-dev',
          driver: 'postgres',
          color: 'green',
          readOnly: false,
          autoSync: true,
          auth: 'none',
          host: 'localhost',
          port: 15544,
          user: 'postgres',
          database: 'acme',
        },
        {
          id: 'shot-staging',
          name: 'acme-staging',
          driver: 'postgres',
          color: 'amber',
          readOnly: false,
          autoSync: true,
          auth: 'none',
          host: 'staging.internal',
          port: 5432,
          database: 'acme',
        },
        {
          id: 'shot-prod',
          name: 'acme-prod',
          driver: 'postgres',
          color: 'red',
          readOnly: true,
          autoSync: true,
          auth: 'pgpass',
          host: 'prod.internal',
          port: 5432,
          database: 'acme',
        },
        {
          id: 'shot-analytics',
          name: 'analytics',
          driver: 'mysql',
          color: 'none',
          readOnly: false,
          autoSync: true,
          auth: 'userPassword',
          host: 'analytics.internal',
          port: 3306,
          database: 'metrics',
        },
      ],
    },
    null,
    2,
  ),
);

const shoot = join(root, 'scripts', 'capture', 'shoot.py');
const baselinePath = join(work, 'baseline.json');
writeFileSync(baselinePath, execFileSync(venvPython, [shoot, 'list']));

// watcher: marker file appears -> take the screenshot for it
const shots = Object.fromEntries(shotNames.map((name) => [name, name]));
const taken = new Set();
const watcher = setInterval(() => {
  for (const [markerName, shotName] of Object.entries(shots)) {
    if (taken.has(markerName) || !existsSync(join(markerDir, markerName))) continue;
    taken.add(markerName);
    try {
      const result = execFileSync(venvPython, [shoot, markerName, join(outDir, `${shotName}.png`), baselinePath]);
      console.log(`[shot:${markerName}]`, String(result).trim());
    } catch (err) {
      console.error(`[shot:${markerName}] FAILED`, String(err));
    }
  }
}, 400);

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'scripts', 'capture', suiteFile),
    launchArgs: [workspace, '--user-data-dir', profile, '--disable-workspace-trust', '--disable-extensions'],
    extensionTestsEnv: {
      TABLECLOTH_CAPTURE: '1',
      TABLECLOTH_DEMO_EXPAND: 'orders',
      TABLECLOTH_MARKER_DIR: markerDir,
    },
  });
} finally {
  clearInterval(watcher);
  rmSync(work, { recursive: true, force: true });
}
console.log('captures in', outDir);
