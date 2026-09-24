// orchestrating-subagents/SKILL.md quotes what subagents and their `agent_summary` requests
// cost. Until 2026-09-23 those figures ($988, $454, $1.19 across 381) had no query behind them
// and could not be re-derived (#578). tests/fixtures/subagent-cost.json is the snapshot the
// paragraph is now written from: raw per-query_source rows from six LogQL queries. This test
// derives every quoted figure from those rows and asserts each literal is in the paragraph, so
// a hand-edited number, or a refreshed fixture the prose was not rewritten for, goes red.
//
// Deliberately not a rerun with a tolerance band: the window is rolling, the query needs Loki,
// and CI has neither. A snapshot is a fact
// with a date on it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { repoPath, srcPath } = require('./lib/paths');

const FIXTURE = JSON.parse(fs.readFileSync(repoPath('tests', 'fixtures', 'subagent-cost.json'), 'utf8'));
const SKILL = srcPath('private_dot_claude', 'skills', 'orchestrating-subagents', 'SKILL.md');
const HEADING = '**Subagents carry a second cost line, `agent_summary`.**';

const sum = (rows, pick) => Object.entries(rows)
  .filter(([k]) => pick(k)).reduce((acc, [, v]) => acc + Number(v), 0);

// Each entry is one literal the paragraph must carry, named by what it is derived from.
function quotedFigures(f) {
  const agentCost = sum(f.cost_usd_by_query_source, (k) => k.startsWith('agent:'));
  const summaryCost = Number(f.cost_usd_by_query_source.agent_summary);
  const summaryReqs = Number(f.requests_by_query_source.agent_summary);
  const completed = sum(f.subagent_completed_by_is_async, () => true);
  const tok = f.agent_summary_tokens;
  return [
    ['measured', f.measured],
    ['subagent cost', `$${Math.round(agentCost)}`],
    ['agent_summary cost', `$${Math.round(summaryCost)}`],
    ['agent_summary cost per completed subagent', `$${(summaryCost / completed).toFixed(2)}`],
    ['subagent_completed events', `${completed} of them`],
    ['agent_summary share of delegation cost', `${Math.round((100 * summaryCost) / (agentCost + summaryCost))}%`],
    ['agent_summary requests per completed subagent', `${(summaryReqs / completed).toFixed(1)} \`agent_summary\` requests`],
    ['mean cache read per agent_summary request', `${Math.round(Number(tok.cache_read) / summaryReqs / 1000)}k cached tokens`],
    ['mean output per agent_summary request', `write ${Math.round(Number(tok.output) / summaryReqs)}`],
  ];
}

// The paragraph alone, so a figure that happens to appear elsewhere in the skill cannot
// satisfy the check for it.
function paragraph(text) {
  const start = text.indexOf(HEADING);
  if (start < 0) return '';
  const end = text.indexOf('\n\n', start);
  return text.slice(start, end < 0 ? undefined : end);
}

function missingFigures(prose, fixture) {
  return quotedFigures(fixture)
    .filter(([, literal]) => !prose.includes(literal))
    .map(([field, literal]) => `${field}: ${literal}`);
}

test('the agent_summary paragraph still matches the snapshot it was written from', () => {
  const prose = paragraph(fs.readFileSync(SKILL, 'utf8'));
  assert.ok(prose.length > 0, `SKILL.md has no paragraph opening ${HEADING}`);
  assert.deepStrictEqual(missingFigures(prose, FIXTURE), []);
});

test('a hand-edited literal in that paragraph is caught', () => {
  const [, literal] = quotedFigures(FIXTURE).find(([field]) => field === 'subagent cost');
  const prose = paragraph(fs.readFileSync(SKILL, 'utf8')).replace(literal, '$988');
  assert.deepStrictEqual(missingFigures(prose, FIXTURE), [`subagent cost: ${literal}`]);
});

// A rename of the query_source values would leave the sums above adding up nothing, and a
// $0 figure would still be "found" if the prose said $0. Pin the members the sums rely on.
test('the snapshot holds the rows the figures are derived from', () => {
  const sources = Object.keys(FIXTURE.cost_usd_by_query_source);
  for (const need of ['agent_summary', 'agent:builtin:general-purpose', 'agent:custom']) {
    assert.ok(sources.includes(need), `missing query_source ${need}`);
  }
  assert.ok(Number(FIXTURE.subagent_completed_by_is_async.true) > 0, 'no subagent_completed rows');
  assert.match(FIXTURE.measured, /^\d{4}-\d{2}-\d{2}$/);
});
