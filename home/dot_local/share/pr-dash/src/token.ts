import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_ITEM = 'op://Private/GitHub PR Dashboard/token';

export type Env = Record<string, string | undefined>;
export type RunOp = (itemRef: string) => Promise<string>;

// Not exported: op read writes the token to stdout, so a rejection from execFile here
// carries the token in its .stdout property. No caller may log this rejection or attach
// it as an Error `cause` — resolveToken's catch below discards it for that reason. Keep
// this function unexported so the only caller stays the one that already does that.
async function runOpRead(itemRef: string): Promise<string> {
  const { stdout } = await execFileAsync('op', ['read', itemRef]);
  return stdout;
}

export async function resolveToken(env: Env, runOp: RunOp = runOpRead): Promise<string> {
  const fromEnv = env['GH_TOKEN']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const itemRef = env['PR_DASH_OP_ITEM']?.trim() || DEFAULT_ITEM;

  let raw: string;
  try {
    raw = await runOp(itemRef);
  } catch {
    throw new Error(
      `Could not read the GitHub token from 1Password. Run:\n\n  op read "${itemRef}"\n\n` +
        `to see why. Set GH_TOKEN to bypass 1Password.`,
    );
  }

  const token = raw.trim();
  if (token === '') {
    throw new Error(`1Password returned an empty token for "${itemRef}".`);
  }
  return token;
}
