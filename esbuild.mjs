import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  minify: !watch,
  // vscode is provided by the host; pg-native and cpu-features are optional native
  // accelerators referenced behind try/catch, and *.node covers ssh2's optional binding.
  external: ['vscode', 'pg-native', 'cpu-features', '*.node'],
  logLevel: 'info',
};

/**
 * The console editor webview: our app plus the whole Monaco editor, bundled
 * from its ESM build. esbuild also emits console.css (Monaco's styles plus the
 * codicon font it references).
 * @type {import('esbuild').BuildOptions}
 */
const consoleWebviewOptions = {
  entryPoints: ['src/webview/console.ts'],
  bundle: true,
  outfile: 'dist/webview/console.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  loader: { '.ttf': 'file' },
  assetNames: '[name]-[hash]',
  logLevel: 'info',
};

/** The Database explorer webview app. */
/** @type {import('esbuild').BuildOptions} */
const explorerWebviewOptions = {
  entryPoints: ['src/webview/explorer.ts'],
  bundle: true,
  outfile: 'dist/webview/explorer.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  logLevel: 'info',
};

/** The anchored menu component as a global, for the plain-JS grid webview. */
/** @type {import('esbuild').BuildOptions} */
const menuGlobalOptions = {
  entryPoints: ['src/webview/menuGlobal.ts'],
  bundle: true,
  outfile: 'dist/webview/menu.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  logLevel: 'info',
};

/**
 * Monaco's editor worker, served to the webview as its own script.
 * editor.worker.js is the self-starting entry (it installs self.onmessage);
 * editor.worker.start.js only exports the start function.
 * @type {import('esbuild').BuildOptions}
 */
const editorWorkerOptions = {
  entryPoints: ['monaco-editor/editor/editor.worker.js'],
  bundle: true,
  outfile: 'dist/webview/editor.worker.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: !watch,
  logLevel: 'info',
};

// node-sqlite3-wasm reads its wasm file relative to its own __dirname, which after
// bundling is dist/, so the wasm blob ships next to extension.js.
function copyWasm() {
  const wasmSrc = join(dirname(require.resolve('node-sqlite3-wasm')), 'node-sqlite3-wasm.wasm');
  mkdirSync('dist', { recursive: true });
  copyFileSync(wasmSrc, 'dist/node-sqlite3-wasm.wasm');
}

const allOptions = [
  extensionOptions,
  consoleWebviewOptions,
  explorerWebviewOptions,
  menuGlobalOptions,
  editorWorkerOptions,
];

if (watch) {
  const contexts = await Promise.all(allOptions.map((options) => esbuild.context(options)));
  copyWasm();
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  for (const options of allOptions) {
    await esbuild.build(options);
  }
  copyWasm();
}
