#!/usr/bin/env bash
set -euo pipefail

default_branch() {
  local ref
  if ref="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)"; then
    echo "${ref#origin/}"; return 0
  fi
  if git show-ref --verify -q refs/remotes/origin/main; then echo main; return 0; fi
  if git show-ref --verify -q refs/remotes/origin/master; then echo master; return 0; fi
  echo main
}

guard_branch() {
  local cur; cur="$(git rev-parse --abbrev-ref HEAD)"
  local def; def="$(default_branch)"
  if [ "$cur" = "main" ] || [ "$cur" = "master" ] || [ "$cur" = "$def" ]; then
    echo "Refusing to run on protected branch '$cur'. Check out your feature branch first." >&2
    return 1
  fi
  return 0
}

metrics() {
  local groups="${1:-1}"
  local def base
  def="$(default_branch)"
  base="$(git merge-base "origin/$def" HEAD)"

  # NOTE: awk's END block must emit a trailing newline -- under `set -e`,
  # `read` from a process substitution with no final newline returns exit
  # status 1 at EOF even though it populated the variables, which would
  # otherwise abort the script here.
  local files add del net
  read -r add del files < <(git diff --numstat "$base"..HEAD | awk '
    { a+=$1; d+=$2; f+=1 } END { printf "%d %d %d\n", a, d, f }')
  net=$((add + del))

  local commits merges fixups
  commits="$(git rev-list --no-merges --count "$base"..HEAD)"
  merges="$(git rev-list --merges --count "$base"..HEAD)"

  # NOTE: `%b` (body-only) is empty for the vast majority of ordinary commits
  # -- a plain `git commit -m "Subject"` has no body distinct from its
  # subject line, so checking `%b` for emptiness flags nearly every commit
  # as a "fixup". Checking the raw message (`%B`) for emptiness instead
  # only fires on a genuinely empty commit message (e.g.
  # `--allow-empty-message`), matching the intended "no meaningful content"
  # signal without misfiring on normal single-line commits.
  fixups=0
  local sha subj rawmsg
  while read -r sha; do
    subj="$(git log -1 --format=%s "$sha")"
    rawmsg="$(git log -1 --format=%B "$sha")"
    if echo "$subj" | grep -Eqi 'wip|fixup|squash|address (review|feedback|comments)|typo|lint' \
       || [ -z "$(echo "$rawmsg" | tr -d '[:space:]')" ]; then
      fixups=$((fixups+1))
    fi
  done < <(git rev-list --no-merges "$base"..HEAD)

  local cleanup=false split=false
  if [ "$merges" -gt 0 ] || [ "$fixups" -gt 0 ] || [ "$commits" -gt 6 ]; then cleanup=true; fi
  if { [ "$files" -gt 10 ] || [ "$net" -gt 400 ] || [ "$commits" -gt 6 ]; } && [ "$groups" -ge 2 ]; then split=true; fi

  printf 'files=%s\nadditions=%s\ndeletions=%s\nnet=%s\ncommits=%s\nmerges=%s\nfixups=%s\ngroups=%s\nneeds_history_cleanup=%s\nsplit_worthy=%s\n' \
    "$files" "$add" "$del" "$net" "$commits" "$merges" "$fixups" "$groups" "$cleanup" "$split"
}

backup() {
  local branch short safe_branch ref
  branch="$(git rev-parse --abbrev-ref HEAD)"
  short="$(git rev-parse --short HEAD)"
  # Sanitize so the backup ref is always exactly one level under backup/ --
  # a raw slash-containing branch name (e.g. feature/x) would otherwise nest
  # the ref path and fail hard if any ref occupies an intermediate segment
  # (e.g. an existing 'backup/feature' branch).
  safe_branch="${branch//\//-}"
  ref="backup/${safe_branch}-${short}"
  git update-ref "refs/heads/${ref}" HEAD
  echo "$ref"
}

assert_tree_equal() {
  local ref="${1:?ref required}"
  if ! git rev-parse -q --verify "${ref}^{commit}" >/dev/null 2>&1; then
    echo "Backup ref '$ref' not found." >&2
    return 1
  fi
  if git diff --quiet "$ref" HEAD; then
    return 0
  fi
  echo "Tree changed vs $ref — history rewrite altered content. Aborting." >&2
  git diff --stat "$ref" HEAD >&2 || true
  return 1
}

cmd="${1:-}"; shift || true
case "$cmd" in
  default-branch) default_branch "$@" ;;
  guard-branch) guard_branch "$@" ;;
  metrics) metrics "$@" ;;
  backup) backup "$@" ;;
  assert-tree-equal) assert_tree_equal "$@" ;;
  *) echo "unknown subcommand: $cmd" >&2; exit 2 ;;
esac
