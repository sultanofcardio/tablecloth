// Runs inside the capture VS Code instance: stages the Plan tab (Explain
// Plan, then Explain Analyse) for the roadmap's example statement and drops a
// marker per shot so run.mjs takes the screenshot.
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

  const uriString = await hooks.newConsole(ds);
  const uri = vscode.Uri.parse(uriString);
  const sql = ['SELECT o.id, c.email, o.total', 'FROM orders o', 'JOIN customers c ON c.id = o.customer_id', "WHERE o.status = 'shipped';"].join('\n');
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(0, 0), sql);
  await vscode.workspace.applyEdit(edit);
  const t0 = Date.now();
  while (!api.consoleEditorBooted() && Date.now() - t0 < 30000) await sleep(200);
  await sleep(1200);

  // 1. Explain Plan: the tree with costs and row estimates
  await hooks.explain(uriString, sql, 'plan');
  await sleep(1500);
  await marker('console-explain-plan', 2500);

  // 2. Explain Analyse: actual rows, time, and the heat bars
  await hooks.explain(uriString, sql, 'analyse');
  await sleep(1500);
  await marker('console-explain-analyse', 2500);

  await marker('done', 500);
};
