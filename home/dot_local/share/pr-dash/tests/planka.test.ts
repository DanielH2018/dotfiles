import { test } from 'node:test';
import assert from 'node:assert';
import { createLoadPlanka, PLANKA_BIN, type RunPlanka } from '../src/planka.ts';

// Synthetic IDs and names only: this repo is public, and the real board belongs to a
// private config.
const BOARD_SHOW = 'board\t100\tBoard\nlist\t1\tIn Progress\n';
const BOARD_BODY = {
  item: { id: '100', name: 'Board', description: 'private' },
  included: {
    lists: [{ id: '1', name: 'In Progress', position: 1, boardId: '100' }],
    cards: [
      {
        id: '10',
        name: 'Card',
        listId: '1',
        position: 2,
        listChangedAt: '2026-10-01T00:00:00.000Z',
        description: 'private notes',
      },
    ],
    users: [{ id: '5', email: 'someone@example.com' }],
  },
};

// Answers each planka subcommand from `answers`, keyed by the subcommand after
// `--strict`, and records every argv it was given.
function fakeRun(answers: Record<string, () => string>): RunPlanka & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const answer = answers[args[1] ?? ''];
    if (answer === undefined) throw new Error(`unexpected planka ${args.join(' ')}`);
    return { stdout: answer() };
  };
  return Object.assign(run, { calls });
}

function exitError(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { code: 1, stderr });
}

test('reads the configured board under --strict and keeps only the fields the panel uses', async () => {
  const run = fakeRun({ board: () => BOARD_SHOW, api: () => JSON.stringify(BOARD_BODY) });
  const result = await createLoadPlanka(run)();
  assert.deepStrictEqual(run.calls, [
    ['--strict', 'board', 'show'],
    ['--strict', 'api', 'GET', '/boards/100'],
  ]);
  assert.deepStrictEqual(result, {
    board: {
      boardId: '100',
      boardName: 'Board',
      included: {
        lists: [{ id: '1', name: 'In Progress' }],
        cards: [{ id: '10', name: 'Card', listId: '1', position: 2, listChangedAt: '2026-10-01T00:00:00.000Z' }],
      },
    },
  });
});

test('a missing CLI is an error naming where pr-dash looked', async () => {
  const run: RunPlanka = async () => {
    throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  };
  assert.deepStrictEqual(await createLoadPlanka(run)(), {
    error: `the planka CLI is not installed at ${PLANKA_BIN}`,
  });
});

test("a failing CLI is an error carrying the CLI's own stderr", async () => {
  const run = fakeRun({
    board: () => {
      throw exitError('planka: no usable config\n');
    },
  });
  assert.deepStrictEqual(await createLoadPlanka(run)(), { error: 'planka: no usable config' });
});

test('a config that names no board is an error', async () => {
  const run = fakeRun({ board: () => '' });
  assert.deepStrictEqual(await createLoadPlanka(run)(), {
    error: 'the planka CLI config names no board (boardId)',
  });
});

test('output that is not JSON is an error', async () => {
  const run = fakeRun({ board: () => BOARD_SHOW, api: () => 'Traceback (most recent call last):' });
  assert.deepStrictEqual(await createLoadPlanka(run)(), {
    error: 'planka api printed something that is not JSON',
  });
});

test('a failed read is retried on the next call, reusing the board ID it already found', async () => {
  let apiCalls = 0;
  const run = fakeRun({
    board: () => BOARD_SHOW,
    api: () => {
      apiCalls += 1;
      if (apiCalls === 1) throw exitError('planka: GET /boards/100: HTTP 503\n');
      return JSON.stringify(BOARD_BODY);
    },
  });
  const load = createLoadPlanka(run);
  assert.deepStrictEqual(await load(), { error: 'planka: GET /boards/100: HTTP 503' });
  assert.ok((await load()).board);
  assert.deepStrictEqual(
    run.calls.map((args) => args[1]),
    ['board', 'api', 'api'],
  );
});
