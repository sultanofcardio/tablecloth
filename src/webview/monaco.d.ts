// monaco's editor.main.js ships without a sibling .d.ts; its API surface is
// the same one editor.api.d.ts declares.
declare module 'monaco-editor/editor/editor.main.js' {
  export * from 'monaco-editor/editor/editor.api.js';
}
