import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** Shared webview HTML for the Services result view and table data editors. */
export function gridHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: 'services' | 'table'): string {
  const nonce = randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'grid.css'));
  const menuCss = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'menu.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'grid.js'));
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
    <button id="tb-refresh" class="ibtn" title="Reload Page (⌘R)"></button>
    <button id="tb-stop" class="ibtn stop" title="Cancel Running Statement" disabled></button>
    <span class="sep"></span>
    <button id="tb-add" class="ibtn" title="Add Row (⌥⌘Insert)"></button>
    <button id="tb-del" class="ibtn" title="Delete Rows (⌘⌫)"></button>
    <button id="tb-revert" class="ibtn" title="Revert Selected (⌥⌘Z)"></button>
    <button id="tb-submit" class="ibtn submit" title="Submit (⌘⏎)"><span id="submit-icon" class="ic"></span><span id="submit-count" class="badge" hidden></span></button>
    <button id="tb-commit" class="ibtn" title="Commit" hidden></button>
    <button id="tb-rollback" class="ibtn" title="Roll Back" hidden></button>
    <span class="sep tx-only"></span>
    <button id="tb-tx" class="tbtn tx-only" title="Transaction mode and isolation"><span id="tx-label">Tx: Auto</span><span class="chev"></span></button>
    <span class="sep tx-only"></span>
    <button id="tb-ddl" class="ddl" title="Open the table DDL">DDL</button>
    <button id="tb-find" class="ibtn" title="Find in page (⌘F)"></button>
    <button id="tb-filter" class="ibtn toggle" title="Show Filter (WHERE and ORDER BY fields)"></button>
    <span class="spacer"></span>
    <button id="tb-extractor" class="tbtn" title="Data extractor used by Copy"><span id="extractor-label">JSON</span><span class="chev"></span></button>
    <span class="sep"></span>
    <button id="tb-export" class="ibtn" title="Export Data…"></button>
    <button id="tb-import" class="ibtn" title="Import Data from File…"></button>
    <span class="sep"></span>
    <button id="tb-view" class="ibtn toggle" title="View: Transpose, Table, Tree, Text"></button>
    <button id="tb-settings" class="ibtn" title="Settings"></button>
  </div>
  <div id="filterrow" class="filterrow" hidden>
    <label class="ffield"><span id="where-icon" class="ficon"></span><span class="wm">WHERE</span><input id="f-where" spellcheck="false" autocomplete="off"></label>
    <label class="ffield order"><span id="order-icon" class="ficon"></span><span class="wm">ORDER BY</span><input id="f-order" spellcheck="false" autocomplete="off"></label>
  </div>
  <div id="findbar" class="findbar" hidden>
    <span id="find-icon" class="ficon"></span>
    <input id="f-find" placeholder="Find in page…" spellcheck="false" autocomplete="off">
    <span id="find-count" class="dim"></span>
    <button id="find-close" class="ibtn" title="Close (Esc)"></button>
  </div>
  <div id="statement" class="statement" hidden></div>
  <div id="gridarea" class="gridarea">
    <div id="gridwrap" class="gridwrap" tabindex="0">
      <div id="placeholder" class="placeholder">Run a statement to see results here.</div>
      <table id="grid" hidden>
        <thead><tr id="head-row"></tr></thead>
        <tbody id="body"></tbody>
      </table>
      <div id="treeview" class="treeview" hidden></div>
      <pre id="textview" class="textview" hidden></pre>
    </div>
    <div id="pager" class="pager-pill" hidden>
      <button id="pg-first" class="icon-btn" title="First page"></button>
      <button id="pg-prev" class="icon-btn" title="Previous page"></button>
      <button id="pg-range" class="range-btn" title="Change page size"></button>
      <span id="pg-of" class="of">of</span>
      <button id="pg-total" class="link"></button>
      <button id="pg-next" class="icon-btn" title="Next page"></button>
      <button id="pg-last" class="icon-btn" title="Last page (needs count)"></button>
      <span id="pg-sep" class="pg-sep"></span>
      <button id="pg-more" class="icon-btn" title="More"></button>
    </div>
  </div>
  <div id="valueeditor" class="valueeditor" hidden>
    <div class="ve-head">
      <span id="ve-title">Value Editor</span>
      <span class="spacer"></span>
      <button id="ve-null" class="tool-btn">Set NULL</button>
      <button id="ve-apply" class="tool-btn primary">Apply</button>
      <button id="ve-close" class="ibtn" title="Close"></button>
    </div>
    <textarea id="ve-text" spellcheck="false"></textarea>
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
    <span id="status-hint" class="hint"></span>
    <span class="spacer"></span>
    <span id="status-busy" hidden>running…</span>
    <span id="status-changes" class="changes" hidden></span>
    <span id="status-right"></span>
  </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
