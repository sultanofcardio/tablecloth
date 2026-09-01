import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** Shared webview HTML for the Services result view and table data editors. */
export function gridHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  mode: 'services' | 'table',
): string {
  const nonce = randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'grid.css'));
  const menuCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'menu.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'grid.js'));
  const menuJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'menu.js'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<link rel="stylesheet" href="${menuCss}">
</head>
<body data-mode="${mode}">
<div id="app">
<div class="main">
  <div id="stree" class="stree" hidden></div>
  <div class="content">
  <div id="tabs" class="tabs" hidden></div>
  <div id="toolbar" class="toolbar" hidden>
    <button id="btn-refresh" class="icon-btn" title="Refresh (re-run)">↻</button>
    <span class="spacer"></span>
    <select id="extractor" title="Data extractor"></select>
    <button id="btn-copy" class="tool-btn" title="Copy rows with the selected extractor (selection, or the whole page)">Copy</button>
    <button id="btn-save" class="tool-btn" title="Export rows to a file (selection, or the whole page)">Export…</button>
  </div>
  <div id="statement" class="statement" hidden></div>
  <div id="gridarea" class="gridarea">
    <div id="gridwrap" class="gridwrap">
      <div id="placeholder" class="placeholder">Run a statement to see results here.</div>
      <table id="grid" hidden>
        <thead><tr id="head-row"></tr></thead>
        <tbody id="body"></tbody>
      </table>
    </div>
    <div id="pager" class="pager-pill" hidden>
      <button id="pg-first" class="icon-btn" title="First page">⇤</button>
      <button id="pg-prev" class="icon-btn" title="Previous page">‹</button>
      <button id="pg-range" class="range-btn" title="Rows per page"></button>
      <span id="pg-of" class="of">of</span>
      <button id="pg-total" class="link"></button>
      <button id="pg-next" class="icon-btn" title="Next page">›</button>
      <button id="pg-last" class="icon-btn" title="Last page (needs count)">⇥</button>
      <div id="size-menu" class="size-menu" hidden></div>
    </div>
  </div>
  <div id="infopane" class="infopane" hidden></div>
  <div id="message" class="msgline" data-empty="1" hidden></div>
  <div id="output" class="output" hidden></div>
  </div>
</div>
  <div id="status" class="status">
    <span id="status-env" class="envdot" hidden></span>
    <span id="status-context"></span>
    <span id="status-ro" class="ro" hidden>read-only 🔒</span>
    <span class="spacer"></span>
    <span id="status-busy" hidden>running…</span>
    <span id="status-right"></span>
  </div>
</div>
<script nonce="${nonce}" src="${menuJs}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
