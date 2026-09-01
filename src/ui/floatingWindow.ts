import * as vscode from 'vscode';

/** Where Tablecloth opens the Data Sources dialog. */
export type SurfacePresentation = 'floatingWindow' | 'editorTab';

export const OPEN_IN_SETTING = 'tablecloth.dataSourceDialog.openIn';

/**
 * Read the user's preferred presentation for the Data Sources dialog.
 * Defaults to a floating window; any unrecognized value falls back to it too.
 */
export function getSurfacePresentation(): SurfacePresentation {
  const configured = vscode.workspace.getConfiguration().get<string>(OPEN_IN_SETTING);
  return configured === 'editorTab' ? 'editorTab' : 'floatingWindow';
}

const NEW_EMPTY_EDITOR_WINDOW = 'workbench.action.newEmptyEditorWindow';
const ENABLE_COMPACT_WINDOW = 'workbench.action.enableCompactAuxiliaryWindow';
const MOVE_EDITOR_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';

/** How long to wait for tab state to reach the extension host. */
const TAB_STATE_TIMEOUT_MS = 3000;

let availableCommands: Set<string> | undefined;
let unavailableNoticeShown = false;

async function hasCommand(id: string): Promise<boolean> {
  if (availableCommands === undefined) {
    try {
      availableCommands = new Set(await vscode.commands.getCommands(true));
    } catch {
      availableCommands = new Set();
    }
  }
  return availableCommands.has(id);
}

/**
 * Tell the user once per session that floating windows are unavailable and
 * that the dialog is opening as an editor tab instead. Staying quiet after the
 * first notice keeps a repeated action from turning into a stream of popups.
 */
function noticeFloatingUnavailable(): void {
  if (unavailableNoticeShown) return;
  unavailableNoticeShown = true;
  void vscode.window.showInformationMessage(
    'Tablecloth: this editor build cannot open a separate window, so the data source dialog opens as an editor tab.',
  );
}

/**
 * Open an empty detached window and leave its editor group focused, so the
 * next thing opened at `ViewColumn.Active` lands straight in it.
 *
 * This is what keeps the dialog from flashing: rendering it in the main
 * window and then moving it shows the content in the wrong place first.
 * Returns false when this build cannot make an empty window, leaving the
 * caller to fall back to `detachActiveEditor`.
 */
export async function openEmptyFloatingWindow(): Promise<boolean> {
  if (!(await hasCommand(NEW_EMPTY_EDITOR_WINDOW))) return false;
  try {
    await vscode.commands.executeCommand(NEW_EMPTY_EDITOR_WINDOW);
  } catch (error) {
    console.error('[tablecloth] opening an empty window failed:', error);
    return false;
  }
  await makeActiveWindowCompact();
  return true;
}

/**
 * Strip the new window back to just its content.
 *
 * The command acts on whichever window has focus, and the one just created
 * does, so this has to run before anything steals it back. Compact mode is a
 * recent addition and the window is perfectly usable without it, so a build
 * that lacks the command is not worth reporting.
 */
async function makeActiveWindowCompact(): Promise<void> {
  if (!(await hasCommand(ENABLE_COMPACT_WINDOW))) return;
  try {
    await vscode.commands.executeCommand(ENABLE_COMPACT_WINDOW);
  } catch (error) {
    console.error('[tablecloth] compacting the new window failed:', error);
  }
}

/**
 * Move the active editor into a new window and return the view column it
 * landed in, or undefined when the editor could not be detached (in which case
 * it stays where it is, as a normal tab).
 *
 * Only used on builds without `newEmptyEditorWindow`; it renders the editor in
 * the main window first, which the user sees as a flash.
 */
export async function detachActiveEditor(
  moved: (tab: vscode.Tab) => boolean,
): Promise<vscode.ViewColumn | undefined> {
  if (!(await hasCommand(MOVE_EDITOR_TO_NEW_WINDOW))) {
    noticeFloatingUnavailable();
    return undefined;
  }
  try {
    await vscode.commands.executeCommand(MOVE_EDITOR_TO_NEW_WINDOW);
  } catch (error) {
    console.error('[tablecloth] detaching editor into a new window failed:', error);
    noticeFloatingUnavailable();
    return undefined;
  }
  return locateColumn(moved);
}

/**
 * The view column of the group holding the tab `owns` matches.
 *
 * Tab state reaches the extension host asynchronously, so a group opened in
 * this turn may not be visible yet; poll briefly rather than reading once.
 */
export async function locateColumn(
  owns: (tab: vscode.Tab) => boolean,
): Promise<vscode.ViewColumn | undefined> {
  const deadline = Date.now() + TAB_STATE_TIMEOUT_MS;
  for (;;) {
    const hosting = vscode.window.tabGroups.all.find((group) => group.tabs.some(owns));
    if (hosting) return hosting.viewColumn;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
