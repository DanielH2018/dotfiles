# Brief: remediate the open Dependabot alerts in one repository

Copy this file into the scratchpad as the common brief. Each agent's own prompt adds four
literal paths (WORKTREE, ALERTS, PR-DRAFT and this brief) plus that repo's notes.

You are one of several agents. Each agent owns one repository and raises every vulnerable
dependency in it past its alert's patched version, or removes the dependency. Your work ends
at a signed local commit and a drafted PR body. The dispatcher pushes nothing until Daniel
approves.

## Inputs

- WORKTREE: a git worktree on the remediation branch, cut from the default branch. Edit only
  inside it.
- ALERTS: a JSON array of this repo's open alerts. Each alert has `number`, `severity`,
  `ecosystem`, `packageName`, `manifestPath`, `scope`, `vulnerableRange` and `patchedVersion`.

## Remove before you bump

A package that is not installed cannot raise an alert, so check for one before bumping it.
For each direct dependency, search the code for its import name. The import name can differ
from the package name: GitPython is `git`, PyYAML is `yaml`, python-dotenv is `dotenv`.

- A CLI tool, a pytest plugin, a type stub or a Pulumi plugin counts as used.
- Remove a dependency only when nothing imports or references it.
- When one trivial call is the only use and the standard library can replace it, replace it.
  For example, `git.Repo(...).head.object.hexsha[:7]` becomes
  `subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], ...)`.
- Narrow an over-broad extra to what the tests use, such as `moto[all]` to `moto[s3]`.

## Bump with the ecosystem's own tool

Make the minimum bump that reaches `patchedVersion`:

| Ecosystem | Command |
|---|---|
| uv | `uv lock --upgrade-package <pkg>==<ver>`; widen the `pyproject.toml` constraint only if it excludes the patch |
| Poetry | `poetry update <pkg>`, after widening the constraint if needed |
| requirements.txt | edit the pin by hand, after checking whether it is generated from a lockfile |
| cargo | `cargo update -p <pkg> --precise <ver>` |
| npm | `npm install <pkg>@<ver>`, or an `overrides` entry for a transitive package |
| bundler | `bundle update --conservative <gem>` |

If the sandbox refuses a registry host, re-run with that host in `allowed_domains`. If a
private index needs credentials you do not have, report that manifest as `blocked`.

## The major-version rule

- **Runtime library:** do not take a semver-major bump. Report it as `major-needed` with the
  current and patched versions. Daniel decides those. For 0.x, a minor bump counts as major.
- **Dev or build tool:** a major bump is allowed if the repo's checks still pass. That covers
  setuptools, pip, black, pytest, wheel, and any alert whose `scope` is `development`.
- **No patch:** an alert with `patchedVersion: null` is `no-patch`, unless removing the package
  clears it.

## duplo

- **Don't let Dependabot or `--upgrade-package` touch duplo.** It resolves from a git tag on
  privacy-com/duplo, and an unrelated PyPI package has the same name. Bump the tag in
  `[tool.uv.sources]` by hand.
- **Read the comment above the duplo pin before bumping it.** Some repos want every duplo bump
  in its own PR, with the Pulumi previews read. If yours does, report `duplo-bump-needed`.
- **Bump duplo only when the gap is small and the changes don't reach your stacks.** Read every
  commit subject in the gap with `git -C ~/Repositories/duplo log --oneline <old>..<new>`.
  Report `duplo-bump-needed` if one changes a component this repo imports from duplo.
- **Fetching duplo needs the sandbox off,** because it comes over ssh from github.com.

## Verify

- **Quote the lockfile line** that shows each package at or above `patchedVersion`, or absent.
- **Run the cheapest real check** that exercises the changed dependencies: `uv lock --check`,
  `poetry check --lock`, `cargo check --locked` or `npm ci --dry-run`.
- **Run the unit tests** if they run locally in under about 5 minutes.
- **Say plainly what did not run**, such as a check that needs AWS, Docker, a database or CI
  secrets. Never claim a pass you did not see.

## Commit and draft

- **Make one signed commit** whose message says why. End it with the attribution lines the
  session gives you.
- **Don't push or open a PR.**
- **Load `pr-authoring`, then write the title and body to PR-DRAFT.** They describe only what
  the change does:
  - the bumps and removals
  - the alerts closed, each one linked
  - side effects a reviewer must see: co-bumped packages, a provider jump, a lockfile format
    rewrite, a hand-edited lockfile
  - verification output
- **Keep open items out of the draft.** Report them to the dispatcher instead.

## Bash

- Start every compound command with `cd <WORKTREE> &&`.
- Write commands literally. That means no `$VAR`, no `$(...)`, no loops or functions, and no
  here-documents. Write file content with the Write tool.

## Stop and report, rather than continue, when

- The repo does not match the alerts. Mark that alert `stale` or `already-fixed` and move on.
- A check fails twice after a reasonable fix.
- A fix needs files outside WORKTREE, or a hook blocks edits in it.
- A human-authored PR named in your prompt already covers an alert. Read its diff, then mark
  the alert `covered-by-#N`.

## Return exactly this

1. A table with one row per alert: `alert # | severity | package | manifest | old | new | status`.
   The status is one of `fixed`, `removed`, `major-needed`, `no-patch`, `blocked`,
   `duplo-bump-needed`, `covered-by-#N`, `already-fixed` or `stale`.
2. The commit hash and its signature status.
3. One line per check: the command and whether it passed.
4. At most three lines on anything the dispatcher must decide.
