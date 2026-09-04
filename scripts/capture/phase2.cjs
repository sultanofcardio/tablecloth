// Runs inside the capture VS Code instance: stages the Phase 2 surfaces (the
// data editor with a change set and the submit preview, filters and a funnel,
// console inspections and parameters, the import dialog) and drops a marker
// per shot so run.mjs takes the screenshot.
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async function run() {
  const markerDir = process.env.TABLECLOTH_MARKER_DIR;
  mkdirSync(markerDir, { recursive: true });
  const tidy = async () => {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => undefined);
    await vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => undefined);
    await sleep(300);
  };
  const marker = async (name, holdMs = 2500) => {
    await tidy();
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

  // 1. the data editor with a change set and the submit preview
  await hooks.openTable(ds, 'orders');
  const t0 = Date.now();
  while (!api.gridReady() && Date.now() - t0 < 20000) await sleep(200);
  await sleep(1500);
  // a short page keeps the added row on screen
  hooks.gridDemo(ds, 'orders', [['filter', 'id <= 12', '']]);
  await sleep(1500);
  hooks.gridDemo(ds, 'orders', [
    ['edit', 0, 2, 'delivered'],
    ['edit', 1, 3, '84.00'],
    ['delete', 2],
    ['add', [[1, '88'], [2, 'pending'], [3, '0.00']]],
    ['focus', 0, 2],
  ]);
  await sleep(800);
  await marker('grid-changes', 2500);
  hooks.gridDemo(ds, 'orders', [['submit']]);
  await sleep(1200);
  await marker('grid-submit', 2500);

  // 2. filters: WHERE / ORDER BY text and a funnel popup
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await sleep(500);
  await hooks.openTable(ds, 'orders');
  await sleep(1500);
  hooks.gridDemo(ds, 'orders', [['filter', "status = 'shipped'", 'created_at DESC']]);
  await sleep(1500);
  hooks.gridDemo(ds, 'orders', [['funnel', 2]]);
  await sleep(1200);
  await marker('grid-filter', 2500);

  // 3. transposed view with the value editor
  hooks.gridDemo(ds, 'orders', [['closePopups'], ['transpose'], ['focus', 0, 4], ['valueEditor']]);
  await sleep(800);
  await marker('grid-transposed', 2500);

  // 4. console: inspections with a quick fix, then the parameters dialog
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const uriString = await hooks.newConsole(ds);
  const uri = vscode.Uri.parse(uriString);
  const sql = [
    'SELECT c.email, count(*) AS order_count',
    'FROM customers c',
    'JOIN orders o ON o.customer_id = c.id',
    'WHERE o.total > :min_total',
    'GROUP BY c.email',
    'ORDER BY order_cnt DESC;',
  ].join('\n');
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), sql);
  await vscode.workspace.applyEdit(edit);
  const t1 = Date.now();
  while (!api.consoleEditorBooted() && Date.now() - t1 < 30000) await sleep(200);
  await sleep(1500);
  await marker('console-inspections', 2500);
  // running the statement prompts for :min_total inside the console
  void hooks.runScript(uriString, sql.replace('order_cnt', 'order_count'));
  await sleep(1200);
  await marker('console-parameters', 2500);

  // 5. the Import Data dialog over a sample CSV
  const csv = join(process.env.TABLECLOTH_MARKER_DIR, 'new_customers.csv');
  writeFileSync(
    csv,
    [
      'Email Address,Full Name,Signup Date,Referral Code',
      'ada@example.com,Ada Lovelace,2026-08-01,FRIEND10',
      'grace@example.com,Grace Hopper,2026-08-02,',
      'edsger@example.com,Edsger Dijkstra,2026-08-03,FRIEND10',
    ].join('\n'),
  );
  await hooks.importFile(ds, 'customers', csv);
  await sleep(3000);
  await marker('import', 3000);

  await marker('done', 500);
};
