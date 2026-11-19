"""The read-only classifier ported from the server repo (dotfiles #628).

APPROVE/REJECT are the server's `test_auto_approve_readonly.py` tables, carried over whole;
the rows that changed verdict in the port sit in their own tests below, each beside the
command that still passes, so a rule that stopped matching fails its own pair. Every case
runs with a temp HOME holding a `server/` repo, so no verdict depends on this host's tree.
"""

import json
import shlex
from pathlib import Path

import pytest

from claude_guard import hook, readonly
from claude_guard.gitread import git_read
from claude_guard.hook import pre_tool_use
from claude_guard.readonly import classify, command_reads_only
from claude_guard.rules import bash_rule_content, parse_rule

FIXTURE = Path(__file__).resolve().parents[5] / "tests" / "fixtures" / "command-vectors.json"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    (tmp_path / "server" / "docs").mkdir(parents=True)
    (tmp_path / ".local" / "share" / "chezmoi").mkdir(parents=True)
    return tmp_path


def ro(command: str, home: Path, cwd: Path | None = None) -> str | None:
    return classify(command, str(cwd or home / "server"), str(home))


APPROVE = [
    "ls",
    "cat foo.txt",
    "git status",
    "rg pattern src/",
    "docker ps",
    "docker logs web",
    "find . -name '*.yml'",
    "cat a.txt | grep foo | head -5",
    "pwd",
    "cd /home/ubuntu/server",
    "cd /srv && ls",
    "cat a; cat b",
    "echo hi; ls; pwd",
    "ls && cat foo",
    "false || ls",
    "cat a\ncat b",
    "echo '=== a ==='\ncat a\necho '=== b ==='\ncat b",
    "cat .yamllint 2>/dev/null",
    "uniq a 2>/dev/null",
    "ls >/dev/null",
    "docker ps 2>&1",
    "grep -r foo . 2>/dev/null | head",
    "awk '{ print length, FILENAME }' file",
    "awk -F: '{print $1}' /etc/passwd",
    "ls | awk '{print $9}'",
    "awk 'NR==1' file",
    "sed -n '1,5p' file",
    # `-e` takes the rest of the word, so its `i` is script text, not `-i`
    "sed -es/i/x/ file",
    # `-n` then `-e` in one cluster: the script after `e` is inspected and harmless
    "sed -nes/a/b/p file",
    "sed 's/foo/bar/' file",
    "echo x | sed 's/x/y/'",
    r"sed -E 's/(public key:|private key:).*/\1 [redacted]/'",
    "grep foo file >/dev/null 2>&1",
    "ls &>/dev/null",
    "grep -r 'a; rm -rf /' .",
    'echo "a; rm b"',
    'echo "x && y | z"',
    "cd docs\n"
    'echo "=== .ansible-lint ==="; cat .ansible-lint\n'
    'echo ""; cat .yamllint 2>/dev/null\n'
    "awk '{ print length, FILENAME }' ansible/roles/containers/x/tasks/main.yml",
    "lsb_release -d",
    "lsb_release -a",
    "mailq",
    "dpkg-query -L docker-ce",
    "dpkg -l",
    "dpkg -l docker-ce",
    "dpkg -L docker-ce",
    "dpkg -s docker-ce",
    "dpkg -S /usr/bin/docker",
    "dpkg -l | grep docker",
    "apt list --installed",
    "apt show jq",
    "apt policy docker-ce",
    "apt search ansible",
    "apt-mark showmanual",
    "apt-mark showauto | sort",
    "pipx list",
    "pipx list --short",
    "pipx environment",
    "pipx --version",
    "crontab -l",
    "crontab -u ubuntu -l",
    "sensors",
    "sensors -f",
    "ss -tlnp",
    "dmesg",
    "dmesg -T --level=err",
    "dmesg --color=never",
    "dmesg -e",
    "dmesg -d",
    "journalctl -u docker -n 50",
    "journalctl --since=-1h",
    "rg -n pattern /var/log/app.log",
    "ping -c 1 10.0.0.161",
    "traceroute 10.0.0.161",
    # over ssh
    "ssh daniel-server docker ps",
    "ssh daniel-pi uptime",
    "ssh ubuntu@daniel-server hostname",
    "ssh daniel-server 'docker ps | head -3'",
    "ssh daniel-server docker ps | head -3",
    "ssh daniel-server docker logs monitor-bridge --since 3h 2>&1 | tail -12",
    "ssh -i /home/ubuntu/.ssh/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes "
    "daniel-server git -C /home/ubuntu/server log --oneline -1",
    "ssh -o BatchMode=yes -o ConnectTimeout=8 daniel-pi hostname",
    "ssh -q -p 22 daniel-server systemctl status traefik",
    "ssh daniel-server 'cd /home/ubuntu/server; git status'",
]

REJECT = [
    "rm -rf /tmp/x",
    "git push",
    "docker run alpine",
    "echo $(whoami)",
    "cat `whoami`",
    "echo ${HOME}",
    "tee out.txt",
    "dd if=/dev/zero of=f",
    "mv a b",
    "python3 script.py",
    "ls > out.txt",
    "cat a >> log.txt",
    "ls &",
    "ls & pwd",
    "cat <<EOF\nhello\nEOF",
    "sed -n 1p - <<EOF\nx\nEOF",
    "(cat a)",
    "cat a; rm b",
    "ls && rm -rf x",
    "cat a | tee out",
    "cat a && echo $(rm x)",
    "cat a\nrm b",
    "awk 'BEGIN{system(\"rm -rf x\")}'",
    "awk '{print > \"out.txt\"}' file",
    "awk '{print | \"sh\"}' file",
    "awk 'BEGIN{while((\"ls\"|getline l)>0) print l}'",
    "awk -f prog.awk file",
    "gawk -i inplace '{print}' file",
    "awk '{print}' > out.txt",
    "diff <(ls) <(ls)",
    "cat a|rm b",
    ">/dev/null",
    "sed '/foo/w out' file",
    "cat a > b 2>/dev/null",
    "uniq a 2 > /dev/null",
    "sed -i 's/a/b/' file",
    "sed -ni 's/a/b/p' file",
    # BSD sed on macOS edits in place with `-I` too (#1019)
    "sed -I '' 's/a/b/' file",
    "sed -I.bak 's/a/b/' file",
    # a script or program file hidden after another flag in one short-option cluster
    "sed '-nes/a/b/w out' p file",
    "sed -nfprog.sed file",
    "sed 's/a/b/w out.txt' file",
    "sed 's/a/b/e' file",
    "sed -n 'w out.txt' file",
    "sed '1e cat /etc/shadow' file",
    "sed -f script.sed file",
    "dpkg",
    "dpkg -i pkg.deb",
    "dpkg --install pkg.deb",
    "dpkg -r docker-ce",
    "dpkg -P docker-ce",
    "dpkg --configure -a",
    "dpkg --unpack pkg.deb",
    "apt install jq",
    "apt remove jq",
    "apt update",
    "apt upgrade -y",
    "apt download jq",
    "apt",
    "apt-get install jq",
    "apt-mark hold docker-ce",
    "apt-mark manual jq",
    "apt-mark unhold docker-ce",
    "pipx install black",
    "pipx uninstall black",
    "pipx run cowsay hi",
    "pipx upgrade-all",
    "crontab",
    "crontab myfile",
    "crontab -r",
    "crontab -e",
    "crontab -u ubuntu -r",
    "sensors -s",
    "sensors --set",
    "ss -K",
    "ss --kill",
    "ss -xKy",
    "dmesg -C",
    "dmesg --clear",
    "dmesg -c",
    "dmesg --read-clear",
    "dmesg -xCy",
    "dmesg -n 1",
    "dmesg -n1",
    "dmesg --console-level=1",
    "dmesg -D",
    "dmesg --console-off",
    "dmesg -E",
    "dmesg --console-on",
    "dmesg -TnD",
    "journalctl --vacuum-size=100M",
    "journalctl --rotate",
    "rg --pre=/tmp/x pattern",
    "nvidia-smi",
    "htop",
    # over ssh
    "ssh daniel-server",
    "ssh daniel-server rm -rf /tmp/x",
    "ssh daniel-server docker run alpine",
    "ssh daniel-server systemctl restart traefik",
    "ssh daniel-server uv run scripts/deploy.py",
    "ssh daniel-server 'cat a; rm b'",
    "ssh daniel-server docker ps | tee out.txt",
    "ssh unknown-host docker ps",
    "ssh root@unknown-host uptime",
    "ssh -o ProxyCommand=nc daniel-server uptime",
    "ssh -o LocalCommand=id daniel-server uptime",
    "ssh -L 8080:localhost:80 daniel-server uptime",
    "ssh -R 80:localhost:80 daniel-server uptime",
    "ssh -D 1080 daniel-server uptime",
    "ssh -A daniel-server uptime",
    "ssh -F /tmp/cfg daniel-server uptime",
    "ssh -o BatchMode=yes",
    "ssh -i",
    "ssh daniel-server cat /home/ubuntu/.ssh/id_ed25519",
    "ssh daniel-server grep -r x /home/ubuntu/.ssh",
    "ssh daniel-server cat /proc/self/environ",
    "ssh daniel-pi cat /home/ubuntu/.aws/credentials",
    "ssh daniel-server cat /home/ubuntu/server/.env",
    "ssh daniel-server cat /proc/self/enviro?",
    "ssh daniel-server ssh daniel-pi uptime",
]


def test_the_ported_tables_are_not_silently_empty():
    assert len(APPROVE) >= 80
    assert len(REJECT) >= 110


@pytest.mark.parametrize("command", APPROVE)
def test_approves_what_the_server_approved(command, home):
    assert ro(command, home)


@pytest.mark.parametrize("command", REJECT)
def test_rejects_what_the_server_rejected(command, home):
    assert ro(command, home) is None


@pytest.mark.skipif(not FIXTURE.exists(), reason="corpus not beside a deployed copy")
def test_the_shared_corpus_readonly_field_holds(home):
    vectors = json.loads(FIXTURE.read_text())["vectors"]
    assert len(vectors) >= 10
    for v in vectors:
        assert (ro(v["command"], home) is not None) == v["readonly"], v["name"]


# --- decision 1: only where the repo's own config is trusted -----------------------------------


def test_a_trusted_repo_and_home_itself_are_approved(home):
    assert ro("git status", home, home / "server" / "docs")
    assert ro("git status", home, home / ".local" / "share" / "chezmoi")
    assert ro("ls", home, home)


def test_an_untrusted_cwd_is_no_decision(home):
    (home / "clone").mkdir()
    (home / "server-evil").mkdir()
    assert ro("ls", home, home / "clone") is None
    assert ro("ls", home, home / "server-evil") is None
    assert ro("ls", home, Path("/tmp")) is None
    assert classify("ls", str(home / "server"), "") is None


def test_git_after_a_cd_is_judged_where_it_runs(home):
    assert ro("cd docs && git status", home)
    assert ro("cd ~/server && git log", home, home)
    assert ro("cd /tmp/clone && git status", home) is None
    assert ro("cd $REPO && git status", home) is None
    assert ro("cd - && git status", home) is None


def test_git_pointed_elsewhere_by_an_option_is_refused(home):
    # as_posix: bash strips the backslashes of an unquoted Windows path; the forward-slash
    # drive form is the one it reads. Identity on POSIX.
    assert ro(f"git -C {home.as_posix()}/server/docs log", home)
    assert ro("git -C /srv log --oneline", home) is None
    assert ro("git --git-dir=/tmp/x/.git log", home) is None
    assert ro("git --work-tree /tmp/x status", home) is None
    assert ro("git -C ../.. status", home) is None


def test_a_program_named_by_path_must_be_a_system_binary(home):
    assert ro("/usr/bin/cat f", home)
    assert ro("/tmp/x/cat f", home) is None
    assert ro("./ls", home) is None


# --- decision 2: the package's stricter lists --------------------------------------------------


def test_verbs_that_print_environment_values_are_refused(home):
    assert ro("docker network inspect bridge", home)
    assert ro("systemctl status traefik", home)
    for command in (
        "printenv",
        "docker inspect web",
        "docker container inspect web",
        "docker config inspect c",
        "systemctl show traefik",
        "systemctl cat traefik",
        "systemctl show-environment",
    ):
        assert ro(command, home) is None, command


@pytest.mark.parametrize(
    "command",
    [
        "diff -u a b",
        "diff -rq dir1 dir2",
        "cmp -l a b",
        "test -f x",
        "[ -d x ]",
        "shasum -a 256 -c sums",
        "md5 -q f",
    ],
)
def test_comparison_and_checksum_verbs_read_under_any_argument(command, home):
    assert ro(command, home)


# Each reader that writes or runs a command under a few arguments, and each REJECT row is one
# of those arguments.
GUARDED_APPROVE = [
    "fd -e py src",
    "fd -H -t f name",
    "fd -l pattern",
    "base64 -d blob.txt",
    "base64 -w0 file",
    "xxd file",
    "xxd -l 64 -c 16 file",
    "xxd -r dump.hex",
    "command -v rg",
    "command -V ls",
    "bash --version",
    "/bin/bash --version",
    "node --version",
    "python3 --version",
    "java -version",
    "fzf --version",
    "git branch",
    "git branch -vv",
    "git branch -a --list 'feat/*'",
    "git branch --show-current",
    "git branch --merged main",
    "git branch --contains HEAD",
    "git branch --sort=-committerdate --format='%(refname:short)'",
    "git tag",
    "git tag -l 'v*'",
    "git tag -n3 v1",
    "git tag --points-at HEAD",
    "git remote",
    "git remote -v",
    "git remote get-url --push origin",
    "git remote show -n origin",
    "git stash list",
    "git stash show -p stash@{0}",
    "git worktree list --porcelain",
    "git reflog",
    "git reflog show -n 5 HEAD",
    "git check-ignore -v foo",
]

GUARDED_REJECT = [
    "fd -x rm",
    "fd -X rm",
    "fd -Hx rm",
    "fd --exec rm {}",
    "fd --exec-batch rm",
    "fd --exe rm",
    "base64 -o out file",
    "base64 -Do out file",
    "base64 --output=out file",
    "base64 --out out file",
    "xxd in out",
    "xxd -r dump.hex out",
    "xxd -l 64 in out",
    "xxd - out",
    "xxd -- in out",
    "xxd in -l",
    "xxd -r dump.hex -revert",
    "command rm x",
    "command -p rm x",
    "node --version --require ./x.js",
    "python3 script.py --version",
    "git branch new-feature",
    "git branch -v new-feature",
    "git branch --sort=refname new-feature",
    "git branch -D old",
    "git branch -m old new",
    "git branch -f main HEAD~1",
    "git branch --set-upstream-to=origin/x",
    "git tag v1",
    "git tag -i v1",
    "git tag -d v1",
    "git tag -a v1 -m x",
    "git tag -v v1",
    "git remote add x https://example.com/x.git",
    "git remote -v add x https://example.com/x.git",
    "git remote set-url origin https://example.com/x.git",
    "git remote remove origin",
    "git remote prune origin",
    "git remote show 'ext::sh -c id'",
    "git remote show origin",
    "git remote -v show origin",
    "git stash",
    "git stash pop",
    "git stash drop",
    "git stash list --output=/tmp/x",
    "git stash show --outp=/tmp/x",
    "git worktree remove x",
    "git reflog expire --all",
    "git reflog delete HEAD@{1}",
    "git -c core.pager=sh branch",
]


@pytest.mark.parametrize("command", GUARDED_APPROVE)
def test_a_guarded_reader_is_approved_in_its_read_form(command, home):
    assert ro(command, home), command


@pytest.mark.parametrize("command", GUARDED_REJECT)
def test_a_guarded_reader_is_refused_in_a_writing_form(command, home):
    assert ro(command, home) is None, command


@pytest.mark.parametrize(
    "command", ["git config --get user.name", "git ls-remote origin", "git merge-base a b"]
)
def test_a_gitread_form_outside_the_listing_ones_stays_with_the_judge(command, home):
    assert git_read(shlex.split(command))
    assert ro(command, home) is None


# --- decision 3: the gaps both copies shared ---------------------------------------------------


@pytest.mark.parametrize(
    ("clean", "flagged"),
    [
        ("git diff --stat", "git diff --output=/tmp/x"),
        ("git log -p", "git log --outp=/tmp/x"),
        ("git grep -n foo", "git grep -Ocat foo"),
        ("git grep foo", "git grep -nO foo"),
        ("git grep foo", "git grep --open-files-in-pager=vim foo"),
        ("sort -u f", "sort --compress-program=gzip f"),
        ("sort -u f", "sort --comp=sh f"),
        ("sort -u f", "sort --outp=out f"),
        ("sed --expression=p f", "sed --exp='1w out' --exp=p a.txt"),
        ("sed -n p f", "sed --in-pl 's/a/b/' f"),
        ("journalctl -n 5", "journalctl --cursor-file=cur"),
        ("journalctl -n 5", "journalctl --vac=1d"),
        ("awk '{print $1}' f", "awk -E prog.awk f"),
        ("awk '{print $1}' f", "awk -l evil '{print}' f"),
        ("awk '{print $1}' f", "awk --file=prog.awk f"),
        ("awk '{print $1}' f", "awk '@include \"inplace\"; {print}' f"),
    ],
)
def test_gap_is_clean_and_is_flagged(clean, flagged, home):
    assert ro(clean, home), clean
    assert ro(flagged, home) is None, flagged


def test_git_grep_pager_cannot_hide_behind_a_dir_option(home):
    assert ro(f"git -C {home}/server grep -Ocat foo", home) is None


# --- the hook wiring ----------------------------------------------------------------------------


def _stdin(command: str, cwd: Path) -> str:
    return json.dumps({"tool_input": {"command": command}, "cwd": str(cwd)})


def test_pre_tool_use_allows_a_read_without_rewriting_it(home):
    out = json.loads(pre_tool_use(_stdin("git status", home / "server"), {"HOME": str(home)}))
    assert out["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert "updatedInput" not in out["hookSpecificOutput"]


def test_pre_tool_use_leaves_an_untrusted_read_to_the_prompt(home):
    assert pre_tool_use(_stdin("git status", Path("/tmp")), {"HOME": str(home)}) is None


def test_a_deny_outranks_the_read_only_allow(home):
    out = json.loads(pre_tool_use(_stdin("git stash pop", home / "server"), {"HOME": str(home)}))
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_a_classifier_failure_is_no_decision(home, monkeypatch):
    def boom(*_):
        raise RuntimeError("x")

    monkeypatch.setattr(readonly, "classify", boom)
    monkeypatch.setattr(hook, "readonly", readonly.readonly)
    assert pre_tool_use(_stdin("ls", home / "server"), {"HOME": str(home)}) is None


def test_the_settings_template_holds_no_bash_allow_rule_this_module_proves(template_permissions):
    proven = []
    for entry in template_permissions["allow"]:
        content = bash_rule_content(entry)
        if isinstance(content, str) and command_reads_only(parse_rule(content).text):
            proven.append(entry)
    assert proven == []
