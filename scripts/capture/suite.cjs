// Runs inside the capture VS Code instance: stages each README surface, then
// drops a marker file so the outer watcher (run.mjs) takes the screenshot.
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CONSOLE_SQL = [
  '-- shipped orders',
  'SELECT o.id, c.email, o.total',
  'FROM orders o',
  'JOIN customers c ON c.id = o.customer_id',
  "WHERE o.status = 'shipped';",
  '',
  // no trailing newline: the caret rests on this statement, so the green
  // execution frame is visible in the shot
  'SELECT * FROM customers;',
].join('\n');

exports.run = async function run() {
  const markerDir = process.env.TABLECLOTH_MARKER_DIR;
  mkdirSync(markerDir, { recursive: true });
  const tidy = async () => {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
    await vscode.commands.executeCommand('workbench.action.files.saveAll').then(undefined, () => undefined);
    await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
    await sleep(400);
  };
  const marker = async (name, holdMs = 2500) => {
    await tidy();
    writeFileSync(join(markerDir, name), '');
    await sleep(holdMs);
  };

  const extension = vscode.extensions.getExtension('sultanofcardio.tablecloth');
  const api = await extension.activate();
  if (!api.capture) throw new Error('capture hooks missing (TABLECLOTH_CAPTURE not set?)');

  // explorer: introspect so the tree renders fully expanded (demo hook)
  await vscode.commands.executeCommand('tablecloth.explorer.focus');
  await api.capture.introspect('shot-acme');
  await sleep(1500);

  // console with the demo query, bound to acme.public
  const uriString = await api.capture.newConsole('shot-acme');
  await sleep(800);
  const uri = vscode.Uri.parse(uriString);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), CONSOLE_SQL);
  await vscode.workspace.applyEdit(edit);
  const t0 = Date.now();
  while (!api.consoleEditorBooted() && Date.now() - t0 < 30000) await sleep(200);
  await sleep(1200);

  // run both statements: a comment-named tab and a table-named tab
  await api.capture.runScript(uriString, CONSOLE_SQL);
  await sleep(2000);
  await marker('hero', 3000);

  // the grid, full-window (no panel, no sidebar - like the plan's mock-up)
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await api.capture.openTable('shot-acme', 'orders');
  await sleep(2000);
  await marker('grid', 3000);

  // the floating Data Sources dialog
  await vscode.commands.executeCommand('tablecloth.addDataSource');
  await sleep(3000);
  await marker('dialog', 3000);

  await marker('done', 500);
};
