import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardView } from './board-view.js';
import type { Blackboard, BoardSnapshot } from './blackboard.js';
import type { Finding } from './types.js';

const finding = (id: string): Finding => ({
  id,
  missionId: 'm1',
  agentId: 'a1',
  kind: 'price',
  payload: {},
  provenance: {
    sourceId: 'espn',
    sourceKind: 'http',
    observedAt: '2026-01-01T00:00:00.000Z',
    fetchedAt: '2026-01-01T00:00:01.000Z',
    contentHash: id.padEnd(64, '0'),
    jobId: 'j1',
  },
});

/** Stub board that hands out one batch per refresh and records what it was asked for. */
function stubBoard(batches: Finding[][]) {
  const asked: string[] = [];
  let i = 0;
  const board = {
    async snapshot(from = '-'): Promise<BoardSnapshot> {
      asked.push(from);
      const batch = batches[i++] ?? [];
      return {
        findings: batch,
        hypotheses: [],
        challenges: [],
        proposals: [],
        lastId: batch.length ? `${i}-0` : null,
      };
    },
  } as unknown as Blackboard;
  return { board, asked };
}

test('refresh accumulates across calls', async () => {
  const { board } = stubBoard([[finding('a'), finding('b')], [finding('c')]]);
  const view = new BoardView(board);
  assert.equal(await view.refresh(), 2);
  assert.equal(await view.refresh(), 1);
  assert.equal(view.state.findings.length, 3);
  assert.deepEqual(
    view.state.findings.map((f) => f.id),
    ['a', 'b', 'c'],
  );
});

test('refresh reads incrementally, never re-reading the whole stream', async () => {
  const { board, asked } = stubBoard([[finding('a')], [finding('b')], []]);
  const view = new BoardView(board);
  await view.refresh();
  await view.refresh();
  await view.refresh();
  // First call starts at the beginning; every later call resumes from the
  // last id it saw. Re-reading from '-' each tick is the bug this guards.
  assert.equal(asked[0], '-');
  assert.equal(asked[1], '1-0');
  assert.equal(asked[2], '2-0');
});

test('an empty batch does not rewind the cursor', async () => {
  const { board, asked } = stubBoard([[finding('a')], [], [finding('b')]]);
  const view = new BoardView(board);
  await view.refresh();
  await view.refresh();
  await view.refresh();
  assert.equal(asked[2], '1-0', 'a quiet tick must not reset to the start of the stream');
  assert.equal(view.state.findings.length, 2);
});

test('the window is bounded — oldest entries drop first', async () => {
  const { board } = stubBoard([
    [finding('a'), finding('b'), finding('c')],
    [finding('d')],
  ]);
  const view = new BoardView(board, 2);
  await view.refresh();
  await view.refresh();
  assert.equal(view.state.findings.length, 2);
  assert.deepEqual(
    view.state.findings.map((f) => f.id),
    ['c', 'd'],
    'a long-running mission must not grow this view without limit',
  );
});

test('size reports the whole accumulated window', async () => {
  const { board } = stubBoard([[finding('a'), finding('b')]]);
  const view = new BoardView(board);
  await view.refresh();
  assert.equal(view.size, 2);
});
