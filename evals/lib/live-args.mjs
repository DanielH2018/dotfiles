// Args for a LIVE run: the skill + real subagent dispatch must engage, so we do
// NOT pass --agent or --tools "". permissionMode defaults to acceptEdits so read
// tools + Task dispatch run headless; the homelab's block-protected-edits hook is
// the write safety-net (the review contract is read-only). Override with
// EVAL_LIVE_PERMISSION_MODE (e.g. 'plan' for a stricter, edit-free run).
export function buildLiveArgs({
  input,
  maxBudgetUsd = 2.0,
  permissionMode = process.env.EVAL_LIVE_PERMISSION_MODE || 'acceptEdits',
}) {
  return [
    '-p', input,
    '--output-format', 'json',
    '--max-budget-usd', String(maxBudgetUsd),
    '--permission-mode', permissionMode,
  ];
}
