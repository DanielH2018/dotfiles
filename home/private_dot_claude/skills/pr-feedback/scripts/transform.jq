def is_passing($s): ($s == "SUCCESS" or $s == "NEUTRAL" or $s == "SKIPPED");

[ .data.search.nodes[]
  | select(.number != null)
  | . as $pr
  | ( [ .reviews.nodes[]? | select(.state != "PENDING" and .state != "DISMISSED") ]
      | reduce .[] as $r ({}; .[$r.author.login] = $r.state)
      | to_entries | map({author: .key, state: .value}) ) as $reviews
  | ( [ .reviewThreads.nodes[]? | select(.isResolved == false)
        | { path: .path,
            line: .line,
            author: (.comments.nodes[0].author.login // null),
            body: (.comments.nodes[0].body // ""),
            url: (.comments.nodes[0].url // $pr.url),
            isOutdated: .isOutdated } ] ) as $threads
  | ( [ .comments.nodes[]? | { author: .author.login, body: .body, url: .url } ] ) as $comments
  | ( [ .commits.nodes[0].commit.statusCheckRollup.contexts.nodes[]?
        | ( if .__typename == "CheckRun"
              then { name: .name, state: (.conclusion // .status), url: .detailsUrl }
              else { name: .context, state: .state, url: .targetUrl } end )
        | select(is_passing(.state) | not) ] ) as $checks
  | ( if ($pr.reviewDecision == "CHANGES_REQUESTED") or (($checks | length) > 0) then 1
      elif (($threads | length) > 0) or (($comments | length) > 0) then 2
      else 3 end ) as $tier
  | { tier: $tier,
      number: .number,
      repo: .repository.nameWithOwner,
      title: .title,
      url: .url,
      branch: .headRefName,
      isDraft: .isDraft,
      updatedAt: .updatedAt,
      reviewDecision: .reviewDecision,
      reviews: $reviews,
      checks: $checks,
      threads: $threads,
      comments: $comments }
]
| sort_by([ .tier, -(.updatedAt | fromdateiso8601) ])
| . as $prs
| { org: $org,
    generated_at: $now,
    counts: { total: ($prs | length),
              attention: ([ $prs[] | select(.tier != 3) ] | length) },
    prs: $prs }
