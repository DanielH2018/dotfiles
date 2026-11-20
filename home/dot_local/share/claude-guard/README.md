# claude-guard

One Python package for Claude Code Bash permission decisions. Slice 1 shipped the segmenter
and the CLI; slice 2 shipped the settings loader, the compound judge, the scratch-rm and
safe-curl checks, and the PermissionRequest hook in shadow; slice 3 ported the remaining
PermissionRequest hooks (readonly-remote, daniel-server host trust, ansible-readonly, plus
#474's clean-reset and #477's compound-bash rule changes), adopted the spec's single-segment
judging, and cut the hook over to live — `guard-permission-request.sh` is now the sole
decision for Bash PermissionRequest, and the six bash hooks it replaces are deleted; slice 4
ported the PreToolUse deny rules and cut `guard-pre-tool-use.sh` over to live, unregistering
`block-dangerous-bash.sh` from the host; slice 6 retired the shadow apparatus on both sides —
the allow side on 2026-09-17 (`CLAUDE_GUARD_SHADOW`, `BASH_CHAIN`, `bash_chain_allows`,
`claude-guard-shadow.jsonl`, `shadow-report`'s allow half, `replay --compare-bash` /
`--compare-hooks`: every `BASH_CHAIN` member was already deleted from disk in slice 3, so
shadow mode was comparing against nothing), and the deny side on 2026-09-18, once the sandbox
port (dotfiles #508) had moved the last runner of `block-dangerous-bash.sh` onto
`guard-pre-tool-use.sh`. That second half deleted `cmdparse.sh`, `block-dangerous-bash.sh`,
their node suites, `CLAUDE_GUARD_DENY_SHADOW`, `claude-guard-deny-shadow.jsonl`,
`shadow-report` and `replay --deny --compare-hook`. Both hooks are live-only and take no
env switch. Spec: `docs/specs/2026-09-06-claude-guard-design.md` (dotfiles repo).

## The segmenter's contract

`claude_guard.segment.parse(command)` returns a `Parsed` whose `status` is `ok` or
`unreadable:<reason>`. **A non-ok status is a refusal, never a skip.** A caller must defer
(PermissionRequest) or ask (PreToolUse); it must never read it as "nothing to worry about".

On `ok`: `segments` are the top-level commands in order, each with the separator that
terminated it (`&&` `||` `;` `|` `&` `newline` `eof`), its lifted heredoc bodies, and whether
each heredoc delimiter was quoted. `substitutions` holds the content of every `$( )`,
`` ` ` ``, `<( )` and `>( )`, flattened across nesting. This is a port of `cmdparse.sh`'s
awk pass and agrees with it field for field (`tests/test_vectors.py`), except that the bash
`heredoc` field cannot represent an empty body — the parity tests there drop empty bodies on
both sides before comparing.

`substitution_spans(command)` comes from the same pass. It locates each outermost
substitution: its kind, where it starts, where its body starts, where it ends, and whether
it sits inside a `${ }`. `mask_substitutions` replaces each span with a placeholder for
`deny.py`'s word readers, and `substitution.mask` cuts the `$( )` and `<( )` spans out for
the judge.

## Running

    claude-guard explain 'git status && ls & rm -rf /'
    printf '%s' 'ls; pwd' | claude-guard segment --json

## The judge

`claude_guard.judge.judge(command, rules, roots, cwd)` is `allow-compound-bash.sh`'s decision,
ported line for line, plus the standalone PermissionRequest hooks it never delegated to (the
three whole-command checks below) and the spec's "a single segment is judged like a chain"
decision: a bare command reaches the same checks a chained one does rather than returning
`not-compound`. It allows a chain when every segment is allow-listed or passes a check
(`checks/scratch.py` for a confined `rm`, `checks/worktree_scratch.py` for an `rm` of
untracked files, a `git clean -f -- <paths>` of untracked files, or a `git restore` to
`HEAD` inside a `.claude/worktrees/<name>` checkout,
`checks/curl.py` for a plain GET/HEAD against an allowlisted host, the
`git merge --ff-only <ref>` exception), and no segment matches deny or
ask, or when the whole command passes one of `checks/remote.py`'s `readonly_remote_safe()` /
`trusted_host_safe()` or `checks/git_reset.py`'s `clean_reset_safe()`. Before a segment is judged, the judge reads
past a loop keyword (`for … in`, `while`, `until`, `do`, `done`) and a literal leading
`NAME=value` whose name `assignments.py` allows, and `git -C <path> <sub>` is judged as
`git <sub>` run in `<path>`. `kubectl -n <ns> <verb>` is judged as `kubectl <verb> -n <ns>`,
which kubectl treats the same, so the rules that name the verb first apply to it. A path that is one double-quoted word of literal text and
`$NAME` references (`git -C "$d" status`) is admitted only for a read. A git read the allow
list cannot express safely goes through `gitread.py`, a table of subcommands that read with
some arguments and write with others (`symbolic-ref`, `ls-remote`, `range-diff`,
`merge-base`). A `$( )`, `<( )` or `>( )` is judged as a command of its own, with no cwd,
and `substitution.py` replaces it in the outer command with a placeholder. The placeholder,
and any variable assigned from it, may stand only in a standalone assignment, a `for` word
list, an argument to a command whose arguments cannot write or exec (`echo`, `cat`, `grep`,
`diff`, …), or a `printf` argument after a literal format. A backtick, or a substitution
inside `$(( ))` or `${ }`, stays `unjudgeable:substitution`. A heredoc stays
`unjudgeable:heredoc` unless it is a quoted-delimiter `cat > path` write or a Python
program read from stdin (`python3 - <<'EOF'`, `uv run python - <<'EOF'`). The judge never
reads that program, because the deny layer has already scanned it, and judges the command
before the heredoc in the segment's place. An unquoted delimiter is admitted only when the
body holds no `$`, backtick or backslash. A redirect is found on the quote-masked text, so a quoted
`>` is an argument, and a `>`/`>>` into a scratch root is allowed when
`checks/scratch.py`'s `write_confined()` vets the target and no segment of the chain can
place a link there first. The two remote checks also run per segment,
so an `ssh`/`hl` stage inside a local pipeline is judged beside the allow-listed readers
around it; `checks/remote_guards.py` holds the per-verb guards (`git`, `sed`, `awk`, `find`,
`apt`, …) a remote argv is held to. `rules.py` reads the deployed settings with the
scope asymmetry the bash documents: allow from `~/.claude/settings.json` alone, deny and ask
from that file plus the project's `.claude/settings.json` and `settings.local.json`.

`Rules.allows` also grants a segment whose command `readonly.command_reads_only` proves a
read by the verb tables. The settings therefore carry no allow rule for `ls`, `grep`,
`find`, `sort` or any other command those tables prove, and
`tests/test_readonly.py` fails when one is added. A guarded verb is granted only the forms
its guard proves, so `find -fls out` and `sort -o out` reach the prompt. `xargs` adds
arguments from stdin that no guard reads, so behind it only a `TIER1` verb is granted
this way.

`hook.decide` is the judge's entry point for the PermissionRequest hook, the prompt
tool, `explain` and `replay --judge`, so the two diagnostics print the verdict a session
gets. Before it reads a rule, it refuses a command that `deny()` or the git conventions
deny. The PreToolUse hook denies such a command before any prompt, so this gate decides
only when that hook could not run. The settings carry no deny rule for `find -exec`, an
awk `system()` or the terraform verbs that change state, because a check denies each.
They keep the force-push and `--no-verify` rules, because Claude Code's own matcher reads
them when the hook is killed at its timeout and `git push:*` is an allow rule.
`tests/test_must_pass.py` holds one command for each settings deny rule a check stands
behind.

    claude-guard explain 'git status && timeout 5 ls'      # segments, then the decision and rule

## The hook, live

`~/.claude/hooks/guard-permission-request.sh` runs `claude-guard permission-request` on the
PermissionRequest event and is the sole decision for Bash PermissionRequest: it computes
`judge()`'s verdict and allows, or stays silent and the prompt stands. Cannot run or cannot
parse → it prints nothing and the prompt stands.

`~/.claude/hooks/read-nudge.sh` runs `claude-guard read-nudge` on PreToolUse for the Read
tool. It decides nothing: a Read with no `offset` or `limit` of a file over 20 KB gets the
once-per-session `whole-file-read` nudge from `claude_guard/nudges.py` as
additionalContext. Cannot run → it prints nothing and the Read goes ahead.

The hook is always live and takes no env switch. Slice 3 cut it over from shadow; slice 6
(2026-09-17, narrowed) retired the `CLAUDE_GUARD_SHADOW` switch itself and the shadow
apparatus it fed (`BASH_CHAIN`, `bash_chain_allows`, `claude-guard-shadow.jsonl`,
`shadow-report`'s allow half, `replay --compare-bash` and `replay --judge --compare-hooks`) —
every `BASH_CHAIN` member (`allow-compound-bash.sh`, `allow-readonly-remote.sh`,
`allow-safe-curl.sh`, `allow-safe-rm.sh`, `allow-ansible-readonly.sh`,
`allow-daniel-server.sh`) was already deleted from disk in slice 3, so shadow mode was
computing a verdict it could compare to nothing.

    claude-guard replay commands.jsonl --judge               # allow count and the allowed commands

`commands.jsonl` is one `{"command": ..., "cwd": ...}` object per line
(`cli.py`'s `_replay_judge`/`_replay_deny`). To ask "how many of the prompts I
actually answered this week would this rule set now answer itself" (dotfiles
issue that used to be `prompt-friction`'s job), pull the corpus straight from
Loki and bridge it with one `jq` line — `otelq`'s `tool_decision` rows carry no
`cwd` label, so this fills the field with `$HOME` the same way `prompt-friction`
filled it with its own analysis process's cwd, not the historical session's:

    otelq logs '{service_name="claude-code"} | event_name="tool_decision" | source=~"user.*" | tool_name="Bash"' --stream --since 7d \
      | jq -c '.data.result[] | . as $s | ($s.stream.tool_parameters | fromjson) as $p | range($s.values|length) | {command: $p.full_command, cwd: $ENV.HOME}' \
      > commands.jsonl
    claude-guard replay commands.jsonl --deny
    claude-guard replay commands.jsonl --judge

The slice 3 cutover gate (spec row 3) was `replay --judge --compare-hooks` allowing at least
84 of the prompted corpus — the floor set by what the #477 prototype allowed — checked
against the pre-cutover bash chain before the six hooks were deleted. `replay --judge` alone
still prints that ALLOW tally and remains the load-bearing gate going forward.

## The headless prompt tool

A `claude -p` session opens no permission dialog, so the PermissionRequest hook never runs
there, and every ask ends as "you haven't granted it yet". A PreToolUse `allow` does not
override a settings `ask` rule either (measured 2026-10-24). `claude-guard prompt-server` is
a stdio MCP server whose one tool, `decide`, a headless launch names with
`--permission-prompt-tool`:

    claude -p --mcp-config '{"mcpServers":{"claude-guard":{"command":"claude-guard","args":["prompt-server"]}}}' \
      --permission-prompt-tool mcp__claude-guard__decide ...

`decide` allows exactly what the PermissionRequest hook allows, by calling the same
`hook.decide`, and denies everything else: another tool, a command the judge defers, a
malformed request, any exception. Claude Code consults it for a settings ask rule and for a
hook's ask, and never after a hook's deny. The request carries no working directory, so the
PreToolUse arm records each Bash call's `cwd` and the environment values the judge reads
under `~/.cache/claude-guard/tool-context/<tool_use_id>.json` (mode 0700, records older than
an hour pruned on write). `decide` reads and deletes the record. With no record it judges
with an empty cwd, which every cwd-dependent check refuses.

## The deny rules, live

`claude_guard.deny.deny(command, cwd, env)` is `block-dangerous-bash.sh`'s decision, ported
rule for rule with the bash line ranges cited in each function and the messages verbatim (the
bash is deleted; the line ranges read against `git show 8bbe82d:home/private_dot_claude/hooks/executable_block-dangerous-bash.sh`,
the last commit that carried it). It
returns a `Verdict` whose `kind` is `deny` or `none`; `deny()` never returns `ask` or
`allow` itself. One rule is not the bash's: the bash rewrote a `--force`/`-f` push to a
feature branch into `--force-with-lease` and allowed it, and `force_push_flag` denies it
with the lease spelling in its reason, matching the settings deny rules (dotfiles #701).
It also denies an `f` in a short-option cluster (`-uf`) and a `+<refspec>` push to any
branch (dotfiles #706).

Every push rule also reads past git's global options (dotfiles #709). `claude_guard.gitargv`
is the one reader of git's command line. It finds the subcommand behind `-C`, `-c`,
`--git-dir` and the rest of `git --help`'s global options, behind an assignment prefix or a
wrapper, and behind an inline alias. `deny()` adds a canonical `git push <args>` line per push
to its segment set. For text the parser cannot read, such as `bash -c '…'`, it uses a
`GIT_PUSH_AT` regex built from the same option table. That regex reads `git push` as text,
and `normalize` deletes the quotes of `subprocess.run(['git', 'push', '--force'])` while
keeping its commas. So `build_scan` adds a member for each text that holds an argument
list, with a space in place of the comma between two string literals (dotfiles #1337). The
member covers a Python list or tuple, the `'git', ['push', …]` of node's `execFileSync`, and
a list `system` call in perl and ruby. The member does not cover a list that a program
builds across statements or from a variable. The readings below cover that list: two for a
force push, and one for a push to main/master, a push that takes inline config, and a push
that skips the hook.

A Python program gets a second reading that needs no adjacent literals (dotfiles #1349).
For a `-c` or stdin program that `inert_python.inert` cannot prove starts no process,
`inert_python.literal_words` collects the words of every string literal, wherever it sits.
The census folds `+` between literals and follows a name the program binds once to one.
`force_push_flag` denies the program when those words hold `git`, a push subcommand or an
inline alias for one, and a force spelling. The three words need not share a list, so a program that starts a plain
push and passes `-f` to another command is denied too. A word the program builds at run
time (base64, `getattr`, `chr()`, `str.join`) is an accepted residual.

`push_main`, `push_config` and `push_no_verify` read a Python program one call at a time
(dotfiles #1372 and #1380). `inert_python.call_arguments` lists the string literals written
inside each call, in source order, with the same three resolutions: `+` between literals,
a starred list, and a name the program binds once. Each list is read as the command line
it spells, by the same patterns that read a shell command. So `a = ['push', 'origin',
'main']; subprocess.run(['git'] + a)` is denied as `push-main`. The words of two calls
never combine: a call that fetches `main` and a call that pushes a feature branch is no
decision, and so is a `git commit --no-verify` in one call and a plain push in the next.
Each string literal is also read on its own, so the command line an `os.system` call takes
is still read.

For these three rules the per-call reading replaces the program's text only where the
lists are everything the program's calls are given. That takes two conditions. The text
is certain to be Python: a closed-shape program (`_plain_python_sources`) that holds no
`$` or backtick and sits in the command once. And `inert_python.calls_are_all_literal`
passes it, which is an allowlist. The whole program is `import` statements, assignments
of one name bound once, and calls to a function that starts a process (`subprocess.run`,
`os.system` and the rest of `_STARTERS`), to a plain builtin such as `print`, or to
`split` on a string literal. Every argument is a literal, a list, tuple, set or dict of
them, a starred list, `+`, an f-string, or a name bound once. A loop, a function, a
class, an attribute read or store, a subscript, or a call to anything else, such as
`os.environ.update`, `getattr` or `exec`, fails it. Any other program
keeps its text reading, with its argument lists joined, and gets the per-call reading on
top. A program that `inert` proves starts no process adds no call.

The per-call reading adds nothing for a list the program builds at run time, with
`append`, `+=`, a loop variable or a parameter. That is the residual the #1349 ruling
accepts, and such a program is read as text, as it was before #1372. A comment is no
literal, so text in one is read only when the program's text is.

A node, perl, ruby or other `_STDIN_CLI` program gets the same reading from its text
(dotfiles #1368). The guard parses none of those languages, so `_program_may_force_push`
splits the whole program at quotes, whitespace, brackets, commas and `;`. A quote does not
have to pair, so an apostrophe in a comment hides no literal. A bracket ends a word, so
perl's `qw(push --force)` and ruby's `%w[push --force]` count, and the `push` of
`list.push(x)` does not. A `qw` or `%w` list may open with another delimiter, as in
`qw/push --force/` or `%w|push --force|`. For each such delimiter in the program, the
census adds the words of a second split that ends a word at that delimiter too. The
second split only adds words, so a format string such as `"%i-%i"` hides nothing. Two literals joined by `+` or `.` read as one word.
`force_push_flag` denies the program on the same three words. No check proves that such a
program starts no process, so a program that only prints the three words is denied too.
The words after the program on the command line are not read, for Python or any other
interpreter.

Two rules are new with #709.
`push_config` denies a push whose inline config (`-c`, `--config-env`, `GIT_CONFIG_*`) sets a
`+` refspec, a refspec onto main/master, or `remote.<name>.mirror`. `push_no_verify` denies
`--no-verify` or an inline `core.hooksPath` on a push. `config_write` denies the persistent
form: a `git config` write of those keys, of an alias that force-pushes, or `git remote add
--mirror`, each of which makes a later plain `git push` do what no flag on it shows.
`--mirror` and `git send-pack` read as force pushes. `checks/git_conventions.py` reads git through the same module and denies a
commit that skips its hooks. The rules
read three subjects the bash builds: the normalised whole command, that plus one line per
segment and substitution, and the segment lines alone for the pair rules. A parse refusal
degrades to the whole-string subject, as the bash does — this is the one place the
segmenter's "a refusal is never a skip" contract reads differently, and it is deliberate,
because this is a port.

`loader_env` is the one deny rule that reads settings. It refuses a command that changes PATH
or a variable that loads code (PYTHONPATH, LD_PRELOAD, NODE_OPTIONS, BASH_ENV and their kin),
by prefix, `env`, `export`, `declare -x` or a bare assignment, and then runs a command by bare
name that the user-level allow rules grant. Claude Code's own matcher prompts for most of
these forms, but it lets a bare `PYTHONPATH=…;` segment through, and that segment loads code
when PYTHONPATH is already exported. Runners, interpreters and plain builtins are exempt,
because their allow rules already run workspace code or load none. The DECIDED comment above
`_LOADER_NAMES` has the measurements.

`wrapper_route` refuses a raw command that a wrapper replaces, and its message names the
wrapper, so no `CLAUDE.md` bullet has to. `gh pr|issue|run` reads, `gh search` and
`gh stack view` route to `ghread`, and so does a `gh api` GET that `ghread api` sends
unchanged (`_ghread_api_takes`; `rate_limit` included), so the GitHub quota ledger counts it.
A field on an explicit `-X GET` is a query parameter, so `gh_api` does not ask about it. `docker ps|images|info|logs`, `docker manifest inspect`
and `docker compose ps|logs` route to `dockq`; `docker run|pull` route to `dockrun`
when dockrun passes every flag, its value and the image to docker unchanged
(`_DOCKRUN_FLAGS`, binds excluded). A bare `-e FOO`, a `-p` without `127.0.0.1:`, or an
empty `--entrypoint` is refused, rewritten or dropped there, so that run or pull stays at
the settings ask, which the operator can approve. `gh run rerun --failed` and a
`> file 2>&1` capture are not refused, because `gh-rerun-failed` serves only repos the
account owns and a redirect is often what is wanted; `claude_guard/nudges.py` names those
wrappers once per session instead. Each of
those is refused only when its wrapper is on the PATH that `env` carries, so a host that has
`gh` or `docker` without the wrappers keeps the raw form. `find -exec`, `-execdir`,
`-ok` and `-okdir` are refused everywhere, with `rg` and `xargs -0` named instead. Writes such
as `gh pr comment` and `docker build` are left to the settings rules.

    claude-guard explain 'ssh homelab sudo reboot'          # unchanged: segments and the judge
    claude-guard replay commands.jsonl --deny                # one line per non-none verdict, then
                                                             # its reason indented; the git
                                                             # conventions are merged in as the
                                                             # PreToolUse hook merges them

`~/.claude/hooks/guard-pre-tool-use.sh` runs `claude-guard pre-tool-use` on PreToolUse for
every Bash call and is the sole decision for Bash PreToolUse on THIS HOST: it computes
`deny()`'s verdict, merged with the footgun rules and `checks/awk.py`, and denies, asks, or
stays silent. `checks/awk.py` (dotfiles #702) denies an awk program that runs a command
(`system()`, `cmd | getline`, `print | "cmd"`, `|&`) and asks on one it cannot read,
that pipes into a variable, that writes a file (`print > "f"`, dotfiles #707) or whose
text holds a shell `$VAR` the guard sees before expansion; the judge refuses both, so the `awk:*` allow rule cannot
approve them from either hook. Its failure contract is the OPPOSITE
of the PermissionRequest shim's: cannot run → it prints `ask` itself, without Python, the
posture the bash took on a missing `jq`. An exception inside Python prints the same `ask` from
`hook.py`. A `uv python find` or a judge that hangs is cut off by `run_bounded` (2s and 6s,
inside the hook's 10s) and takes the same `ask` (#660).

`bypass.py` denies a call that sets `dangerouslyDisableSandbox` when the command would run
inside the sandbox unchanged. That means the sandbox is enabled, `judge()` allows the
command, every stage is a `readonly.py` read, nothing needs the network, and no
`denyRead` path is named. The denial tells the model to run it again without the flag. Like
`readonly.py`, it fails open.

`protected_paths.py` denies a command that can change a file the guard rests on: a hook
under `~/.claude/hooks/`, the package under `~/.local/share/claude-guard/`,
`~/.claude/settings.json` and `settings.local.json`, and a tool in `~/.local/bin/`. The rule
refuses by default. A command that names one of those paths as a word passes only when it
cannot write it: a read `readonly.py` proves, the path as the program being run, a source
of `cp`, the target of `ln -s`, `chezmoi`, or a program the guard cannot read, such as a
script file. So no write verb needs a rule of its own. The module docstring lists how a
word is resolved (home spellings, the working directory, globs, links on disk, variables
the command sets) and what the rule does not read. `deny()` takes the session's working
directory for this rule alone. The rule also reads an interpreter's inline program and a
sed script that writes a file, for a protected path spelled from the home directory.
`WRITE_TARGETS` does not list `~/.local/bin`: the rules that read that list match a path
named anywhere in the command, and running a tool by its full path is ordinary.

`checks/sed.py` and `checks/program_options.py` deny a command an allow rule approves by
name when it runs a program the guard does not read. `sed.py` parses each sed script and
denies one that holds the `e` command or the `e` flag of `s`, and one it cannot read
(`-f`, an abbreviated long option, a script that is only a variable). It parses instead of
scanning for the letter, because the text after `a`, `i` and `c`, a label and both halves
of `s` are data. `program_options.py` denies `man -P`, `go test -exec`, `go build
-toolexec`, `go vet -vettool` and `uv run <URL>`. No package runner (`npx`, `npm exec`,
`pnpm dlx`, `bunx`, `uvx`, `pipx run`, `go run` of a module path) has an allow rule, so
each is left to its prompt. `tests/test_must_pass.py` holds the case table: `GUARD_ROUTES`
must be denied, `PACKAGE_RUNNERS` must not be approved, and the rows beside them in
`HEADLESS` are the nearest ordinary commands, which must pass.

`checks/cli_verbs.py` reads two families of subcommand that a prefix rule cannot, because
the words sit behind options. It denies a command that prints a credential to the
transcript: `gh auth token`, `gh auth status --show-token` in any position, a cloud CLI's
token printer, `kubectl config view --raw`, and `kubectl get secret` with an output format
that shows the data. A substitution that is the whole value of an assignment is captured,
not printed, so `GH_TOKEN=$(gh auth token) cmd` passes. It asks on a `claude` subcommand
that rewrites Claude Code's own configuration (`plugin install`, `mcp add`, `update`), as
an Edit of `~/.claude/settings.json` asks. The `plugin` and `mcp` groups ask by default
and pass a list of read subcommands. The tables in `tests/test_must_pass.py` are
`CREDENTIAL_PRINTERS`, `CLAUDE_SETTINGS_WRITERS` and the commands beside them that must
pass.

`checks/read_only_agents.py` (dotfiles #848) is a deny rule beside the worktree-escape
check. When the payload's `agent_type` names an agent whose frontmatter under
`~/.claude/agents/` sets `read_only: true`, it denies a write redirect outside the scratch
roots, a command that changes files outside them, a shell or `eval`, and any git or gh verb
outside a read-only set. Its module docstring says why the rest is a denylist.

`checks/homelab_deploy.py` (dotfiles #1321, #1326, #1334, #1342, #1346, #1347, #1354, #1355) asks on a hand-run write to the
live homelab. It matches three commands: a `gh workflow run` of the server repo's `promote`
workflow, wherever `-R` sits in the argv; a run of `hosts/bootstrap-host.sh`; and a
`systemctl start` or `restart` of `homelab-reconcile`. It reads each one locally and inside
the remote text of an `ssh` or `hl` call or a `sh -c` string. A shell or ssh call that
executes its stdin also runs what it reads there: a `< file`, a heredoc or herestring body,
or a `cat` piped into it. So `ssh host bash -s < hosts/bootstrap-host.sh` matches. An
`echo` or `printf` piped into it writes its arguments as script text, a `printf` format
filled with its arguments. A shell inside a
`>( )` reads the stdout of the stage that names it. `source` and `.` run a script file as
a shell does. A shell inside an ssh remote text or a `-c` string executes the stdin of the
stage that carries it, so `bash -c 'sh' < hosts/bootstrap-host.sh` matches. `eval` runs
its arguments as script text. A `$( )` in them, in a remote text or in a `-c` string
stands for the stdout of its body. A variable is expanded to every value the same command
assigns it, whether or not the shell reaches the assignment, so
`x='systemctl start homelab-reconcile'; ssh host "$x"` matches. A command that nests
shells or expands variables past what the check reads asks too, since the check drops
nothing to bound its work. It asks only when the payload's
`permission_mode` is `default`, `manual`, `acceptEdits` or `plan`. Auto mode is left to the
`soft_deny` prose, which clears the dispatch the server repo's post-merge procedure prints.
A settings `ask` rule cannot make that split, because Claude Code honours an ask rule in
auto mode too. The judge's trusted-host arm does not allow an ssh payload the check matches,
so a PermissionRequest allow cannot answer the ask before the user sees it.

Three rules read text that no command runs, and they skip it only where that is provable.
`rm_root` matches each segment, substitution and heredoc body on its own. It leaves out a
stored heredoc. It also leaves out a grep, echo or printf whose `rm` is only quoted, and an
inert Python program, but only when every other segment is a `cd` or a reader or printer
that `inert_shell.py` proves, so a pipe into `at` or `crontab` keeps the text. A second
Python program keeps the text too, since it may run a file the first one wrote.
`pipe_to_shell` matches a stage after a pipe at its start, unless the stage runs code. It
counts `at` and `batch` as shells, because each reads a shell script on stdin. A stored
heredoc stays in the scan when another segment runs code, and `at`, `batch` and `crontab`
count as running code, since each runs a file it is given. The sudo boundary reads a
command line that `bash -c`, `eval` or another executor wraps, to five levels. Past that
it searches the text for an escalator's name and reports sudo when it finds one. Otherwise
it denies under the `nest-too-deep` rule, whose reason says to run the inner command
directly (dotfiles #1373). The sudo boundary skips the word search in a closed-shape Python program that
`inert_python.py` proves starts no process. That module is an allowlist of imports, attributes
and builtins, and it refuses a program naming a shell-startup, settings, hook or PATH file.
A program that may change a file passes only when each write goes to a string literal with
a data suffix, such as `.md`, `.json` or `.yaml` (dotfiles #1339). Python puts the working
directory first on `sys.path` for a `-c` or stdin program, so `import json` runs a
`./json.py` the program wrote a line earlier. The allowlist has no types, so it reads the
destination from the shape of the call: `open('a.md', 'w')`, `Path('a.md').write_text(…)`,
or a name bound once to `Path('a.md')`. A path that is joined, globbed, computed or passed
in is refused, and so is `open`, `Path` or a writing method that is passed or aliased. A
segment that redirects the program's output into a file without a data suffix is refused
as well. The boundary skips the program under the same condition `rm_root` has: every
other segment is a `cd` or a reader or printer, and the command has no substitution. An
edit of a `.py` or `.sh` file that holds `sudo` as text goes through the Edit tool instead.
A week's replay over 32,188 commands took the deny count from 316 to 262. No command went
from allowed to denied (2026-10-24). The boundary also reads a Python script's own arguments
as data, past a literal `.py` path, so a `findings.py open --title` that names sudo passes.
That took the same replay from 262 to 258 (dotfiles #1000). Several rules then moved from
matching the joined scan to confirming against the parse: gh api's flags come from gh's own
argv, a grep pattern and a sed `s` script are one word, sed and perl -i edit only their file
operands, and a pipe into kill or a shell running a named script is judged at the stage. A
Jinja `secret.yaml.j2` template is not a secrets file. That took the replay from 243 denies
and 15 asks to 208 and 4, with nothing newly refused (2026-10-24).

`secret_readers` passes a read of an SSH public key (dotfiles #1250). The command word
must be a bare `cat`, `head`, `tail` or another reader that can write no file, and the key
must be a plain path that ends in `.pub`, with no expansion, glob, brace or `..`. The secret
table is unchanged, so the interpreter rules, the write rules and the Read tool still
match every path under `.ssh/`, and a write to a `.pub` file stays refused.

The push rules (`force_push`, `push_main`, `force_push_flag`, `push_config`,
`push_no_verify`, `config_write`) and `machine_config_write` match `git push` and
`git config` as text anywhere in a segment, so that `bash -c '…'` and an ssh payload stay
covered (dotfiles #1312 for `machine_config_write`). `machine_config_write` passes a read
only when the `git config` is a command of its own, so a read inside a `bash -c` argument
or an ssh payload is denied with the writes. Each line of a heredoc
body is a member of the segment set too when a shell, a scheduler, `make` or `ssh` reads
the body on stdin, directly, behind a wrapper such as `env` or `sudo`, at the end of a
pipe, or inside a subshell or a group whose closer carries the heredoc (dotfiles #1289).
A body that a data sink stores counts too when the command runs code. A body that an
interpreter reads counts as well, because `os.system('git push --force')` in a heredoc
program runs the push (dotfiles #1314). Three Python shapes are left out. A program
that `inert_python.inert` proves starts no process only names the text, so
`python3 <<'EOF'` with a `print` of push text passes. A literal `.py` script reads the
body as data, and so does a `-c` program that starts no process. All three hold only
when every other segment is a reader or a printer and the command has no substitution.
Any other segment, another Python program included, may run a file the first one
wrote. Every other
interpreter has no such proof: `node <<'EOF'` with a `console.log` of push text is
refused. A body fed to any other command is data, so
`grep -c x <<'EOF'` over push text passes. A stored heredoc is stripped before that. A flag such as
`--force` ends at any character that cannot continue the word, because a flag that closes
a quoted program is followed by `)` or `;` once the quotes are removed. `deny` skips the
push rules for a
command that `inert_shell.runs_none_of_its_words` proves runs nothing it names, so
`grep -n 'git push --force' README.md` passes (dotfiles #1249). That proof is an allowlist.
Every segment must be grep, rg with options from a fixed list, echo, printf with a format
first, one of head, tail, wc, cat, cut, tr and nl, or a `git commit`, `git grep` or
`git log` (dotfiles #1272). The command name must be the bare
word. A git segment spells the subcommand straight after `git`, because a global option
can set an alias or config that a hook's child git reads. It holds no glob, and a
`git grep` holds no `-O` or `--open-files-in-pager`, which runs its value. The proof refuses an expansion, a substitution, a heredoc, a group, backgrounding,
and every redirect except `/dev/null` and `&1`/`&2` written as one unquoted word. One
segment outside the list keeps the push rules on for the whole command. rg reads
`RIPGREP_CONFIG_PATH` from the environment, which the command cannot set under this proof
and which the proof does not read.

One rule goes the other way and refuses by default. `python_write` refuses a `python -c`
program, or a program Python reads from a heredoc, that names a secrets, shell-startup or
git config/hook file in its text or in an argument after it (dotfiles #1251). The program
passes only when `inert_python.read_only` proves it changes no file. That proof is the
`inert` allowlist without the attributes that write, create, move or delete a file. It
passes an `open` only as a call whose mode is a literal read mode, read at the position
each opener keeps it: second for the builtin, first or second for an `x.open(…)`. The
interpreter is any word whose basename is `python…`, so a path-spelled interpreter and an
`env`, `timeout` or `nice` leader are covered without a list of leaders. `uv run -` and
`uv run --script -` run the program on stdin with no `python` word, so a `uv` runner whose
command word is `-` or another descriptor counts as an interpreter too (dotfiles #1286).
`secret_interpreter` reads the same programs, and the words after each, for a secret
path: its pattern needs an interpreter word before the path. It reads the program piped
to `node`, `deno`, `bun`, `perl`, `ruby`, `php`, `Rscript` or `osascript` too (dotfiles
#1324). Each of those reads stdin as its program when its words give no inline program
(`-e`) and no script file. `_STDIN_CLI` lists each interpreter's options, and an option the
list lacks leaves the program on stdin, so a gap in the list refuses and never passes.
One of those names counts as an interpreter wherever it sits in a segment, so every
leader is covered without a list of leaders (`timeout 5 node`, `bundle exec ruby`). The
exception is a command that `_NAMES_ONLY` lists, which runs none of the words after it:
`grep`, `which`, and a package manager under a subcommand such as `install` or `view`.
So `brew install node` and `grep node` after a segment that names a secret path pass, and
a command missing from that list keeps the refusal.
`python_write` leaves those programs alone, because its read-only proof reads Python
source. `interpreter_write` covers them instead (dotfiles #1344). It refuses a program one
of those interpreters reads from stdin or a descriptor, or takes inline with `-e` or its
equivalent, when the program names a secrets, shell-startup or git config/hook file. No
read-only proof exists for those languages, so the rule refuses a program that only reads
the file as well. The operator accepted that over-refusal on 2026-11-14. The words after
`deno eval` are an inline program too (dotfiles #1362).

A program of one of those interpreters can take the path from the words after it. The rule
refuses such a program only when it can write (dotfiles #1363 and #1365, operator rulings
2026-11-14). Either the command carries an in-place edit flag (`-i`, `-i.bak`), or the
program text calls an API from the interpreter's `writes` list in `_STDIN_CLI`. A call
that deletes or truncates a file counts as a write. The lists:

- node: `writeFile`, `appendFile`, `createWriteStream`, `copyFile`, `rename`, `unlink`,
  `rm` and `truncate`, with their `Sync` forms, and `open` with a `w`, `a` or `r+` flag.
- bun: node's list, `Bun.write`, a `.writer()` call, and a `.write()` or `.delete()`
  call in a program that holds `Bun.file`.
- perl: `open` with a `>` mode, `rename`, `copy`, `move`, `unlink` and `truncate`.
- ruby: `File.write`, `IO.write`, `FileUtils`, `File.open` with a `w` or `a` mode,
  `File.delete`, `File.unlink`, `File.truncate` and `File.rename`.
- php: `file_put_contents`, `fopen` with a mode that starts `w`, `a`, `x` or `c` or
  holds `+`, `rename`, `copy`, `unlink` and `ftruncate`.
- deno: node's list, which a `node:fs` import reaches, `Deno.writeFile`,
  `Deno.writeTextFile`, `Deno.rename`, `Deno.copyFile`, `Deno.remove`, `Deno.truncate`
  and `Deno.create`, with their `Sync` forms, and `Deno.open` in a program that holds a
  `write`, `append`, `create`, `createNew` or `truncate` option.

So `perl -ne 'print' ~/.zshrc`, which reads its operand as data, passes. A program that
builds the API name at run time passes too, and the rulings accept that. An interpreter
with no `writes` list fails closed: the rule refuses `Rscript` or `osascript` given such a
path whatever the program text says.

The rule reads an inline program after an option `_STDIN_CLI` does not list, and past the
one word that may be that option's value, so a gap in the list refuses here too. An
interpreter's name counts with a version suffix (`ruby3.2`, `perl5.36`) and as `nodejs`.
One program shape passes although it names a protected file: a single perl substitution
that runs no code, as in `perl -pi -e 's/secrets.yml/x/' docs/a.md`. Its text names no
file, which `inplace_edit` already holds for an in-place perl. The pattern and
the replacement must be literal text, with no `$`, `@`, `\` or `(`, since perl evaluates
code through each of those. A substitution with the `e` flag is refused as well.

A script file's program stays out of reach. `python_write` also reads what the program is given: whatever its
segment redirects in, and every earlier segment of the command, which may be the program
itself or its arguments under `xargs`. Reading every earlier segment needs no model of
pipes, groups or descriptors, and costs a writer refused after an unrelated segment that
names a protected file. An earlier segment is not read as the program when the
interpreter's segment fills stdin itself and the program comes from stdin, so a read-only
heredoc after `grep -c foo ~/.bashrc` passes (dotfiles #1288). The segment fills stdin
itself when a heredoc or a here-string lands on stdin, and the segment holds no redirect on
a numbered or named (`{fd}`) descriptor, no duplication such as `<&3`, no process
substitution as a redirect's target and no `<` file redirect, whose file an earlier segment
may have written.

A program that an earlier segment prints is read out of that segment in two places
(dotfiles #1303). The first is a segment piped straight into an interpreter that
redirects nothing onto stdin. The interpreter is the first word of its segment, or follows
only leaders that hand stdin on untouched: `timeout DURATION`, `nice` with an optional
`-n N`, `env` with assignments, and `uv run` with value-free options (dotfiles #1331). The
second is the body of a `<(…)` operand. The rule reads the operands of an `echo`, the operands of a `printf`
whose format is `%s`, `%s\n` or plain text ending lines with `\n`, and the one heredoc a
bare `cat` forwards. A printer reads no stdin, so its text is the whole program and no
segment before it is a candidate: `grep -c foo ~/.bashrc; echo 'print(1)' | python3`
passes. Every other producer is still refused when an earlier segment names a protected
file, because the rule reads that producer's shell text as the program. So is a printer
behind any other leader, such as `xargs`, which turns the piped text into arguments, or a
listed leader given another option. So is an `echo` whose operand holds a backslash, and a printer
with an output redirect, which may send its text somewhere other than the pipe. A
brace group piped onward by a bare `}` is read as what its members print, in order, when
every member is a printer that ends in `;` or a newline. A subshell, a nested group, a
group with a redirect and a group with any other member are refused as before. A `<(…)` operand narrows the candidates only when every
substitution of the command is a printer, because a substitution such as `<(cat)` reads
the stdin it inherits. A printer is read only at the top level of the command, and only
when every segment before it is a reader or a printer that `inert_shell.py` proves. Any
other earlier segment could rebind the printer's name, so the rule then reads every
earlier segment as a candidate program again.

Over 27,268 distinct commands from this
host's transcripts the rule refused 77 (2026-11-14), 12 of them probes of the guard itself. Most of the rest were
edit scripts that rewrite a file under `.claude/hooks/`, or whose replaced text names
`secrets.yml` or `.bashrc`; the denial points those at the Edit tool.

When nothing above decides, `readonly.py` (dotfiles #628, ported from the server repo's
`auto-approve-readonly.py`) allows a command whose every stage is provably read-only. It
applies only when the session cwd is `$HOME` itself or inside `~/server` or
`~/.local/share/chezmoi`, because git reads a repo's own config and that config can run
code. A failure inside it is no decision, never the `ask` above: it can only remove a prompt.

`waits.py` is the `cc-wait` binding (docs/specs/2026-10-04-cc-wait-design.md). Beside the
rules above it denies a hand-written wait in the foreground: `sleep` of 10s or more, a loop
around `sleep`, `tail -f`, `gh run watch`, `gh pr checks --watch` and `kubectl … --watch`. A
call that runs `cc-wait` on a source gets an `updatedInput` and no decision; `cc-wait
<source> --help` prints usage, so it is left in the foreground. Where a task notification can
wake the session, that is `run_in_background: true` (an interactive `claude`, a bridge session,
or a desktop-app session run as `~/.claude/remote/ccd-cli/<version>`); where one cannot, it is a 600s foreground
timeout. A failure inside the rewrite leaves the call as typed.

The oracle for the rules is `tests/test_deny.py` against
`tests/fixtures/block-dangerous-bash-vectors.json` (32 deny / 27 allow groups, 281 commands),
plus `tests/test_deny_normalization.py`'s generated property corpus. The bash they were ported
from is gone, so there is no second implementation to agree with any more; the agreement
record that cleared the cutover is below.

The cutover gate (spec row 4) was `shadow-report --deny` showing at least 200 records
collected over at least 3 days, with zero `python_only`, `bash_only`, `mismatch`,
`detail_mismatch`, `python_error`, `bash_error` and `bash_timeout` rows, checked against the
host-registered bash before the cutover; measured 11,973 records over 6.6 days at zero across
the board, with `replay --deny --compare-hook` at `AGREE 1058/1058` on the prompted corpus and
`AGREE 281/281` on the vectors. The sandbox port repeated the vector replay inside the
container against the interpreter the image resolves before slice 6 deleted the bash and the
tooling that produced those numbers.

## Tests

From this directory, under uv's managed 3.14, without writing a `.venv` into the source tree:

    PYTHONPATH=. uv run --no-project --python 3.14 --with 'pytest>=8.0' pytest -p no:cacheprovider -q

`tests/python-suites.test.js` at the repo root runs the same command as part of `node --test`.

`tests/test_must_pass.py` is the must-pass corpus: commands claude-guard must never refuse,
seeded from transcript denials, with a false-deny budget of zero. Every row goes through the
PreToolUse hook against the real settings template, and a `HEADLESS` row also through the
headless prompt tool. `MUST_REFUSE` holds a case for each deny check that guards an
interpreter, through each interpreter form. To add a row, cut a real denial down to the
shape that reproduced it.
