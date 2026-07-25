// node:test custom reporter for tq. Emits one NDJSON record per event the
// digest needs and nothing else, so a 529-test run costs a few hundred bytes
// instead of the 54 KB the default reporter writes.
import path from 'node:path';

// stdout/stderr events report the file as it was named on the command line,
// while test events report it absolute; resolve both so they can be matched.
function abs(file) {
  return typeof file === 'string' && file ? path.resolve(file) : null;
}

// details.error is always an ERR_TEST_FAILURE wrapper with the real error on
// .cause. A *string* cause — what a file-level assert crash produces — leaves
// us at the wrapper, whose message is the useless "test failed"; the adapter
// recovers those from the file's captured stderr instead.
function rootError(err) {
  let e = err;
  while (e && typeof e === 'object' && e.cause && typeof e.cause === 'object') e = e.cause;
  return e;
}

function serialize(err) {
  const e = rootError(err);
  if (!e || typeof e !== 'object') return { name: '', message: String(e ?? ''), stack: '' };
  const out = { name: e.name || '', message: e.message || '', stack: e.stack || '' };
  // execFileSync/spawnSync hang the child's captured streams off the error.
  // Most of this repo's tests shell out, so this is the output that matters —
  // and unlike test:stdout events it belongs to one test, not one file.
  for (const stream of ['stdout', 'stderr']) {
    if (e[stream] != null) out[stream] = String(e[stream]);
  }
  return out;
}

function rec(o) {
  return JSON.stringify(o) + '\n';
}

export default async function* tqReporter(source) {
  for await (const ev of source) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'test:fail':
        yield rec({
          t: 'fail',
          file: abs(d.file),
          defLine: d.line ?? null,
          name: d.name,
          todo: Boolean(d.todo),
          error: serialize(d.details && d.details.error),
        });
        break;
      case 'test:pass':
        // Only todo passes matter downstream — they are node's xpass. Emitting
        // every pass would defeat the point of the reporter.
        if (d.todo) yield rec({ t: 'pass', file: abs(d.file), name: d.name, todo: true });
        break;
      case 'test:stdout':
        yield rec({ t: 'out', file: abs(d.file), text: d.message ?? '' });
        break;
      case 'test:stderr':
        yield rec({ t: 'err', file: abs(d.file), text: d.message ?? '' });
        break;
      case 'test:summary':
        // One per file, then a final one with no `file` holding the run totals.
        yield rec({
          t: 'summary',
          file: abs(d.file),
          counts: d.counts,
          duration_ms: d.duration_ms,
        });
        break;
    }
  }
}
