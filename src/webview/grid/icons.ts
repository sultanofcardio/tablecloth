// Tabler-style stroke icons (MIT) for the grid toolbar and headers.
const stroke = (paths: string, width = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const ICONS = {
  refresh: stroke('<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>'),
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
  plus: stroke('<path d="M12 5l0 14"/><path d="M5 12l14 0"/>'),
  minus: stroke('<path d="M5 12l14 0"/>'),
  revert: stroke('<path d="M9 14l-4 -4l4 -4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/>'),
  submit: stroke('<path d="M12 5l0 14"/><path d="M18 11l-6 -6"/><path d="M6 11l6 -6"/>'),
  commit: stroke('<path d="M5 12l5 5l10 -10"/>', 2.5),
  rollback: stroke('<path d="M3 12a9 9 0 1 0 9 -9"/><path d="M3 4v4h4"/><path d="M3 12l6 -6"/>'),
  find: stroke('<path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>'),
  filterTable: stroke(
    '<path d="M4 4h16v4h-16z"/><path d="M4 8v11a1 1 0 0 0 1 1h6"/><path d="M4 12h8"/><path d="M12 8v6"/><path d="M14 14h7l-2.5 3v4l-2 -1v-3z"/>',
  ),
  funnel: stroke('<path d="M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z"/>'),
  funnelArrow: stroke(
    '<path d="M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z"/>',
  ),
  sortLines: stroke('<path d="M4 6l9 0"/><path d="M4 12l7 0"/><path d="M4 18l7 0"/><path d="M15 15l3 3l3 -3"/><path d="M18 6l0 12"/>'),
  download: stroke('<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/>'),
  upload: stroke('<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 9l5 -5l5 5"/><path d="M12 4l0 12"/>'),
  eye: stroke('<path d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"/>'),
  gear: stroke(
    '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/>',
  ),
  chevron: stroke('<path d="M6 9l6 6l6 -6"/>', 2.5),
  chevronRight: stroke('<path d="M9 6l6 6l-6 6"/>', 2),
  key: stroke(
    '<path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z"/><path d="M15 9h.01"/>',
  ),
  column: stroke(
    '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M10 10h11"/><path d="M10 3v18"/>',
  ),
  sortBoth: stroke('<path d="M8 9l4 -4l4 4"/><path d="M16 15l-4 4l-4 -4"/>'),
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="#548af7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="#56a8f5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/></svg>',
  console: stroke('<path d="M8 9l3 3l-3 3"/><path d="M13 15l3 0"/><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/>'),
  power: stroke('<path d="M7 6a7.75 7.75 0 1 0 10 0"/><path d="M12 4l0 8"/>'),
  arrowUpRight: stroke('<path d="M17 7l-10 10"/><path d="M8 7l9 0l0 9"/>', 2.5),
  close: stroke('<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>'),
  check: stroke('<path d="M5 12l5 5l10 -10"/>', 2.5),
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>',
  first: stroke('<path d="M10 12l10 0"/><path d="M10 12l4 4"/><path d="M10 12l4 -4"/><path d="M4 4l0 16"/>'),
  prev: stroke('<path d="M15 6l-6 6l6 6"/>', 2.5),
  next: stroke('<path d="M9 6l6 6l-6 6"/>', 2.5),
  last: stroke('<path d="M14 12l-10 0"/><path d="M14 12l-4 4"/><path d="M14 12l-4 -4"/><path d="M20 4l0 16"/>'),
  // completion lookup kinds (the explorer draws the same glyphs)
  table: stroke(
    '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"/><path d="M3 10h18"/><path d="M10 3v18"/>',
  ),
  schema: stroke(
    '<path d="M3 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M15 15m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M9 3m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z"/><path d="M6 15v-1a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v1"/><path d="M12 9l0 3"/>',
  ),
  func: stroke(
    '<path d="M3 19a2 2 0 0 0 2 2c2 0 2 -4 3 -9s1 -9 3 -9a2 2 0 0 1 2 2"/><path d="M5 12h6"/><path d="M15 12l6 6"/><path d="M15 18l6 -6"/>',
  ),
};
