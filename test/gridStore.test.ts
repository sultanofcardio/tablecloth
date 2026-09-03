import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GridColumnDto, GridMetaDto, ResultMessage } from '../src/ui/gridProtocol';
import {
  addInsertedRow,
  cellDisplay,
  editFromCommit,
  loadResult,
  setEdit,
  toChangeSet,
} from '../src/webview/grid/store';

function column(name: string, extra: Partial<GridColumnDto> = {}): GridColumnDto {
  return {
    name,
    dataType: 'text',
    numeric: false,
    sortable: true,
    key: false,
    fk: null,
    editable: true,
    autoIncrement: false,
    hasDefault: false,
    nullable: true,
    kind: 'text',
    ...extra,
  };
}

const meta: GridMetaDto = {
  dialect: 'postgres',
  contextLabel: 'orders',
  envColor: null,
  readOnly: false,
  statement: null,
  editable: true,
  readOnlyReason: null,
  wholeRowKey: false,
  referencing: [],
  tx: null,
  canCancel: false,
  canImport: false,
  canDdl: false,
  canFilter: true,
  defaultPageSize: 500,
};

/** One existing row over id (auto), status (defaulted), note (nullable). */
function load(): void {
  const message: ResultMessage = {
    type: 'result',
    columns: [
      column('id', { numeric: true, key: true, autoIncrement: true, hasDefault: true, nullable: false, kind: 'numeric' }),
      column('status', { hasDefault: true, nullable: false }),
      column('note'),
    ],
    rows: [[1, 'pending', 'first']],
    page: { offset: 0, pageSize: 500, shown: 1, hasMore: false, total: 1, generation: 1 },
    where: '',
    orderBy: '',
    duration: '1 ms',
    extractors: [],
    binaryExtractors: [],
    activeExtractor: 'csv',
    meta,
  };
  loadResult(message, [80, 80, 80]);
}

test('an editor left untouched on an added row keeps the placeholder instead of writing an empty value', () => {
  load();
  const r = addInsertedRow();
  assert.deepEqual(
    [0, 1, 2].map((c) => cellDisplay(r, c).text),
    ['auto', 'default', '<null>'],
  );
  // opening and closing the editor on each cell without typing changes nothing
  for (const c of [0, 1, 2]) {
    const edit = editFromCommit(r, c, '');
    assert.equal(edit, undefined, `column ${c} takes no edit`);
    if (edit) setEdit(r, c, edit);
  }
  assert.deepEqual(
    [0, 1, 2].map((c) => cellDisplay(r, c).text),
    ['auto', 'default', '<null>'],
  );
  assert.deepEqual(
    toChangeSet().inserts.map((row) => row.cells),
    [{}],
    'the submitted INSERT leaves every untouched column to the database',
  );
});

test('text typed into an added row becomes a value, including an emptied one', () => {
  load();
  const r = addInsertedRow();
  const typed = editFromCommit(r, 1, 'shipped');
  assert.deepEqual(typed, { kind: 'value', text: 'shipped' });
  setEdit(r, 1, typed);
  assert.equal(cellDisplay(r, 1).text, 'shipped');
  const emptied = editFromCommit(r, 1, '');
  assert.deepEqual(emptied, { kind: 'value', text: '' });
  setEdit(r, 1, emptied);
  assert.equal(cellDisplay(r, 1).text, '');
});

test('an existing cell only records an edit when the text changes', () => {
  load();
  assert.equal(editFromCommit(0, 1, 'pending'), undefined);
  assert.deepEqual(editFromCommit(0, 1, 'shipped'), { kind: 'value', text: 'shipped' });
});
