import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The default lookup is by item title, searched across every vault the user can see,
// because the vault holding this item is not a portable name: a personal 1Password
// account calls it "Private", and a Business account names each member's own vault
// differently. Hardcoding a vault segment ties the tool to one account's naming.
export const DEFAULT_TITLE = 'GitHub PR Dashboard';

const TOKEN_FIELD_LABEL = 'token';

export type Env = Record<string, string | undefined>;

export type OpLookup =
  | { kind: 'read'; ref: string }
  | { kind: 'itemGet'; title: string };

export type RunOp = (lookup: OpLookup) => Promise<string>;

// Not exported: both op commands write the token to stdout, so a rejection from execFile
// here carries the token in its .stdout property. No caller may log this rejection or
// attach it as an Error `cause` — resolveToken's catch below discards it for that reason.
// Keep these unexported so the only caller stays the one that already does that.
async function runOpRead(ref: string): Promise<string> {
  const { stdout } = await execFileAsync('op', ['read', ref]);
  return stdout;
}

async function runOpItemGet(title: string): Promise<string> {
  const { stdout } = await execFileAsync('op', [
    'item',
    'get',
    title,
    '--fields',
    `label=${TOKEN_FIELD_LABEL}`,
    '--reveal',
    '--format',
    'json',
  ]);
  return stdout;
}

async function defaultRunOp(lookup: OpLookup): Promise<string> {
  return lookup.kind === 'read' ? runOpRead(lookup.ref) : runOpItemGet(lookup.title);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function opCommandFor(lookup: OpLookup): string {
  return lookup.kind === 'read'
    ? `op read "${lookup.ref}"`
    : `op item get "${lookup.title}" --fields label=${TOKEN_FIELD_LABEL} --reveal --format json`;
}

function opFailureMessage(lookup: OpLookup): string {
  const pin =
    lookup.kind === 'itemGet'
      ? ' If the title is ambiguous across vaults, or op runs as a service account ' +
        '(which requires a vault), set PR_DASH_OP_ITEM to a precise ' +
        '"op://vault/item/field" reference.'
      : '';
  return (
    `Could not read the GitHub token from 1Password. Run:\n\n  ${opCommandFor(lookup)}\n\n` +
    `to see why.${pin} Set GH_TOKEN to bypass 1Password.`
  );
}

// `op item get --fields ... --format json` is expected to print an array of field
// objects, but that shape is unverified — op cannot run in this sandbox. This also
// accepts the full-item `{ fields: [...] }` shape and a single bare field object, so an
// unnarrowed response still resolves; anything else is an empty list, which the caller
// reports as "no field labeled token" rather than crashing on a shape it didn't expect.
function fieldsFrom(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed['fields'])) return parsed['fields'];
  if (isRecord(parsed)) return [parsed];
  return [];
}

function isTokenField(value: unknown): value is { value: string } {
  if (!isRecord(value)) return false;
  const label = value['label'];
  const fieldValue = value['value'];
  return (
    typeof label === 'string' &&
    label.toLowerCase() === TOKEN_FIELD_LABEL &&
    typeof fieldValue === 'string'
  );
}

// Never includes `raw` in a thrown message: it is the JSON op item get printed with
// --reveal, so it holds the token in plain text.
function extractTokenField(raw: string, lookup: { kind: 'itemGet'; title: string }): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Could not parse the response from op item get "${lookup.title}" --format json: ` +
        `it was not valid JSON.`,
    );
  }

  const match = fieldsFrom(parsed).find(isTokenField);
  if (match === undefined) {
    throw new Error(
      `The op item get "${lookup.title}" response has no field labeled ` +
        `"${TOKEN_FIELD_LABEL}".`,
    );
  }
  return match.value;
}

export async function resolveToken(env: Env, runOp: RunOp = defaultRunOp): Promise<string> {
  const fromEnv = env['GH_TOKEN']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const configured = env['PR_DASH_OP_ITEM']?.trim();
  const lookup: OpLookup =
    configured === undefined || configured === ''
      ? { kind: 'itemGet', title: DEFAULT_TITLE }
      : configured.startsWith('op://')
        ? { kind: 'read', ref: configured }
        : { kind: 'itemGet', title: configured };

  let raw: string;
  try {
    raw = await runOp(lookup);
  } catch {
    throw new Error(opFailureMessage(lookup));
  }

  const token = (lookup.kind === 'read' ? raw : extractTokenField(raw, lookup)).trim();
  if (token === '') {
    const target = lookup.kind === 'read' ? `"${lookup.ref}"` : `"${lookup.title}"`;
    throw new Error(`1Password returned an empty token for ${target}.`);
  }
  return token;
}
