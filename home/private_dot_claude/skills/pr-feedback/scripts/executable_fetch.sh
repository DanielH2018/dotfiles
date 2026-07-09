#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORG="${PR_FEEDBACK_ORG:-privacy-com}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

read -r -d '' QUERY <<'GQL' || true
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        updatedAt
        headRefName
        reviewDecision
        repository { nameWithOwner }
        reviews(last: 20) { nodes { author { login } state submittedAt } }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            isOutdated
            path
            line
            comments(first: 1) { nodes { author { login } body url createdAt } }
          }
        }
        comments(first: 50) { nodes { author { login } body url createdAt } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
GQL

if [[ -n "${PR_FEEDBACK_FIXTURE:-}" ]]; then
  raw="$(cat "$PR_FEEDBACK_FIXTURE")"
else
  raw="$(gh api graphql -f query="$QUERY" -f q="author:@me is:pr is:open org:${ORG}")"
fi

printf '%s' "$raw" | jq -f "$SCRIPT_DIR/transform.jq" --arg org "$ORG" --arg now "$NOW"
