// Launches a real VS Code instance with the built extension and runs the
// smoke suite inside its extension host. Requires `npm run build` first.
import { runTests } from '@vscode/test-electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspace = mkdtempSync(join(tmpdir(), 'tablecloth-e2e-'));

// When launched from a VS Code terminal this is inherited and makes the
// spawned VS Code run as plain node, which then tries to require() the
// workspace path. Strip it so Electron starts as the real app.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test', 'vscode', 'suite', 'index.cjs'),
    launchArgs: [workspace, '--disable-workspace-trust', '--disable-extensions'],
    // the suite drives the extension through the test hooks, which the API
    // only exposes under this flag
    extensionTestsEnv: { TABLECLOTH_TEST_HOOKS: '1' },
  });
} catch {
  console.error('VS Code smoke test failed');
  process.exit(1);
}
