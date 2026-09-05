// Runs inside the capture VS Code instance: stages the DELETE-without-WHERE
// surfaces (the inspection in a console, then the pre-execution warning with
// its row count) and drops a marker per shot so run.mjs takes the screenshot.
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async function run() {
  const markerDir = process.env.TABLECLOTH_MARKER_DIR;
  mkdirSync(markerDir, { recursive: true });
  const marker = async (name, holdMs = 2500) => {
    await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
    await sleep(300);
    writeFileSync(join(markerDir, name), '');
    await sleep(holdMs);
  };

  const extension = vscode.extensions.getExtension('sultanofcardio.tablecloth');
  const api = await extension.activate();
  const hooks = api.capture;
  if (!hooks) throw new Error('capture hooks missing (TABLECLOTH_CAPTURE not set?)');
  const ds = 'shot-acme';

  await vscode.commands.executeCommand('tablecloth.explorer.focus');
  await hooks.introspect(ds);
  await sleep(800);
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');

  // 1. the inspection: a DELETE with no WHERE is marked in the console
  const uriString = await hooks.newConsole(ds);
  const uri = vscode.Uri.parse(uriString);
  const sql = '-- clear the test orders\nDELETE FROM orders;';
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), sql);
  await vscode.workspace.applyEdit(edit);
  const t0 = Date.now();
  while (!api.consoleEditorBooted() && Date.now() - t0 < 30000) await sleep(200);
  await sleep(1500);
  await marker('console-without-where', 2500);

  // 2. running it asks first, naming the table and its row count
  void hooks.runScript(uriString, 'DELETE FROM orders;');
  await sleep(1500);
  await marker('console-without-where-dialog', 2500);

  await marker('done', 500);
};
