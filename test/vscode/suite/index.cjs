// Smoke suite run inside the VS Code extension host. Exercises the extension
// the way a user would: define a data source in settings, run a .sql file on
// it, and check the database really changed.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vscode = require('vscode');

/** Tab state reaches the extension host asynchronously; poll briefly. */
async function pollForTab(owns, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.tabs.find(owns);
      if (tab) return tab;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

exports.run = async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'tablecloth-suite-'));
  const dbFile = join(dir, 'smoke.db');
  const sqlFile = join(dir, 'script.sql');
  writeFileSync(
    sqlFile,
    `CREATE TABLE greetings (id INTEGER PRIMARY KEY, message TEXT NOT NULL);
     INSERT INTO greetings (message) VALUES ('hello'), ('world');
     SELECT * FROM greetings ORDER BY id;`,
  );

  // 1. activation
  const extension = vscode.extensions.getExtension('sultanofcardio.tablecloth');
  assert.ok(extension, 'extension is installed in the dev host');
  await extension.activate();
  assert.ok(extension.isActive, 'extension activates');

  // 2. contributed commands are registered
  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    'tablecloth.addDataSource',
    'tablecloth.runStatement',
    'tablecloth.runFile',
    'tablecloth.runFileOnDataSource',
    'tablecloth.newConsole',
    'tablecloth.queryHistory',
    'tablecloth.txMode',
    'tablecloth.commit',
    'tablecloth.rollback',
    'tablecloth.selectSchema',
  ]) {
    assert.ok(commands.includes(id), `command registered: ${id}`);
  }

  // 3. define a SQLite data source through settings (the store's source of truth)
  // — a per-run id keeps console files and state from earlier runs out of the
  // way, since the test host's user-data directory persists across runs
  const runId = `e2e-${Date.now()}`;
  await vscode.workspace.getConfiguration().update(
    'tablecloth.dataSources',
    [
      {
        id: runId,
        name: 'smoke',
        driver: 'sqlite',
        color: 'green',
        readOnly: false,
        autoSync: true,
        auth: 'none',
        file: dbFile,
      },
    ],
    vscode.ConfigurationTarget.Global,
  );

  // 4. run the script on it end to end (single data source: no picker appears)
  await vscode.commands.executeCommand('tablecloth.runFileOnDataSource', vscode.Uri.file(sqlFile));

  // 5. the database file must now contain the data
  const { Database } = require('node-sqlite3-wasm');
  const db = new Database(dbFile, { readOnly: true });
  try {
    const rows = db.all('SELECT message FROM greetings ORDER BY id');
    assert.deepEqual(
      rows.map((r) => r.message),
      ['hello', 'world'],
      'script ran against the data source',
    );
  } finally {
    db.close();
  }

  // 6. a console opens in the custom Tablecloth console editor
  await vscode.commands.executeCommand('tablecloth.newConsole');
  const consoleTab = await pollForTab(
    (tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'tablecloth.console',
  );
  assert.ok(consoleTab, 'console opens as a Tablecloth console editor tab');

  // 7. Monaco actually boots inside the console webview (worker, CSP and all)
  const deadline = Date.now() + 20000;
  while (!extension.exports.consoleEditorBooted() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(extension.exports.consoleEditorBooted(), 'monaco booted inside the console editor webview');
  await vscode.window.tabGroups.close(consoleTab);

  // 9. the webview explorer resolves when its view is focused
  await vscode.commands.executeCommand('tablecloth.explorer.focus');
  {
    const deadlineExplorer = Date.now() + 10000;
    while (!extension.exports.explorerResolved() && Date.now() < deadlineExplorer) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(extension.exports.explorerResolved(), 'explorer webview resolved');
  }

  // 10. the Data Sources dialog opens (in a floating window where the build
  // supports one; as a tab otherwise) — either way its webview tab must exist
  await vscode.commands.executeCommand('tablecloth.addDataSource');
  const dialogTab = await pollForTab(
    (tab) => tab.input instanceof vscode.TabInputWebview && tab.label === 'New Data Source',
  );
  assert.ok(dialogTab, 'data source dialog tab appears');
  await vscode.window.tabGroups.close(dialogTab);

  console.log('tablecloth smoke suite passed');
};
