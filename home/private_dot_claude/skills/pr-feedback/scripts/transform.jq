def is_passing($s): ($s == "SUCCESS" or $s == "NEUTRAL" or $s == "SKIPPED");

(.data.viewer.login) as $me
| [ .data.search.nodes[]
  | select(.number != null)
  | . as $pr
  | ( [ .reviews.nodes[]? | select(.state != "PENDING" and .state != "DISMISSED") ]
      | reduce .[] as $r ({}; .[$r.author.login] = $r.state)
      | to_entries | map({author: .key, state: .value}) ) as $reviews
  | ( [ .reviewThreads.nodes[]? | select(.isResolved == false)
        | (.comments.nodes[-1]) as $last
        | select($last != null
                 and $last.author.login != $me
                 and (($last.author.__typename // "") != "Bot"))
        | { path: .path,
            line: .line,
            author: ($last.author.login // null),
            body: ($last.body // ""),
            url: ($last.url // $pr.url),
            isOutdated: .isOutdated } ] ) as $threads
  | ( [ .comments.nodes[]?
        | select(.author.login != $me
                 and ((.author.__typename // "") != "Bot"))
        | { author: .author.login, body: .body, url: .url } ] ) as $comments
  | ( .commits.nodes[0].commit.statusCheckRollup.state ) as $rollup
  | ( [ .commits.nodes[0].commit.statusCheckRollup.contexts.nodes[]?
        | ( if .__typename == "CheckRun"
              then { name: .name, state: (.conclusion // .status), url: .detailsUrl }
              else { name: .context, state: .state, url: .targetUrl } end )
        | select(is_passing(.state) | not) ] ) as $checks
  | ( ($rollup == "FAILURE") or ($rollup == "ERROR") ) as $checks_failing
  | ( if ($pr.reviewDecision == "CHANGES_REQUESTED") or $checks_failing then 1
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
      checksState: $rollup,
      checksFailing: $checks_failing,
      checks: $checks,
      threads: $threads,
      comments: $comments }
]
| sort_by([ .tier, -(.updatedAt | fromdateiso8601) ])
| . as $prs
| { org: $org,
    generated_at: $now,
    viewer: $me,
    counts: { total: ($prs | length),
              attention: ([ $prs[] | select(.tier != 3) ] | length) },
    prs: $prs }
