import { readFileSync } from 'node:fs';
import { createServer } from './server.ts';
import type { PrRecord } from './types.ts';

const secret = process.env['PR_DASH_SECRET'];
if (secret === undefined || secret === '') {
  console.error('PR_DASH_SECRET is not set. Start the dashboard with `pr-dash`.');
  process.exit(1);
}
const port = Number(process.env['PR_DASH_PORT'] ?? 8770);

// Slice 1 serves the fixture. Task 8 replaces this with the GitHub fetch.
const fixture: PrRecord[] = JSON.parse(
  readFileSync(new URL('../tests/fixtures/records.json', import.meta.url), 'utf8'),
);

const server = createServer({ secret, loadPrs: async () => fixture });
server.listen(port, '127.0.0.1', () => {
  console.log(`pr-dash listening on http://127.0.0.1:${port}`);
});
