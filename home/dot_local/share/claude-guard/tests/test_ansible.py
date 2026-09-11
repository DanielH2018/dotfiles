"""tests/hooks/allow-ansible-readonly.test.js, case for case.

The JS fixture (checked 2026-09-11) carries 14 ALLOW and 15 DEFER cases, not the 12/14 the
task brief cited — ported here in full, not thinned; see also `git log` for the fixture's
own history. The two gap cases and the four hazard cases below are additions the plan calls
for that the bash's own suite never had.
"""

import pytest

from claude_guard.checks.ansible import ansible_readonly_safe

# allow-ansible-readonly.test.js ALLOW (14 cases).
ALLOW = [
    "ansible-playbook site.yml --check",
    "ansible-playbook site.yml --list-tasks",
    "ansible-playbook site.yml --list-tags",
    "ansible-playbook site.yml --list-hosts",
    "ansible-playbook site.yml --syntax-check",
    "ansible-playbook site.yml --check --diff",
    "uv run ansible-playbook site.yml --check",
    "uv run --frozen ansible-playbook site.yml --list-tasks",
    "stdio-blocking; ansible-playbook site.yml --check",
    "stdio-blocking; uv run ansible-playbook site.yml --check --tags x",
    "ansible-playbook site.yml --check 2>&1 | tail -n 50",
    "stdio-blocking; ansible-playbook site.yml --check 2>&1 | tail -n 12",
    # The shape uv-python.sh actually produces on the homelab: a bare -N count.
    "stdio-blocking; uv run ansible-playbook ansible/deploy.yml --tags karakeep "
    "--check 2>&1 | tail -3",
    "ansible-playbook site.yml --check -e foo=bar",
]

# allow-ansible-readonly.test.js DEFER (15 cases, empty string included).
DEFER = [
    # No read-only mode named at all.
    "ansible-playbook site.yml",
    "ansible-playbook deploy.yml --tags traefik",
    "uv run ansible-playbook site.yml",
    # A read-only flag word buried inside an -e/--extra-vars STRING value must not count.
    "ansible-playbook site.yml -e 'msg=--check'",
    "ansible-playbook site.yml --extra-vars 'msg=--list-tasks'",
    # A file-valued extra-vars disqualifies even alongside --check.
    "ansible-playbook site.yml --check -e @vars.yml",
    "ansible-playbook site.yml --check --extra-vars @vars.yml",
    "ansible-playbook site.yml --check --extra-vars=@vars.yml",
    "ansible-playbook site.yml --check -e@vars.yml",
    # Chaining beyond the one recognized trailing pipe is a refusal.
    "ansible-playbook site.yml --check && echo pwned",
    "ansible-playbook site.yml --check; echo pwned",
    "ansible-playbook site.yml --check | tee /tmp/x",
    # Not this hook's command at all.
    "echo ansible-playbook --check",
    "ansible-vault view secrets.yml",
    "",
]

# The two gap cases the survey identified: the bash's own suite never covered either.
GAP_DEFER = [
    # "uv run" followed by neither "ansible-playbook" nor "--frozen".
    "uv run pytest --check",
    # A totally unterminated quote.
    "ansible-playbook site.yml --check 'unterminated",
]

# --- Hazard 1: the leading strip is a literal prefix regex, not a recognised token. A
# space before the semicolon is a DIFFERENT string the bash's regex never matched, so it
# reaches the tokenizer unstripped and dies on the bare `;`. ---
HAZARD_DEFER = [
    "stdio-blocking ; ansible-playbook site.yml --check",
]


@pytest.mark.parametrize("command", ALLOW)
def test_a_provably_read_only_ansible_playbook_invocation_is_allowed(command):
    assert ansible_readonly_safe(command) is True


@pytest.mark.parametrize("command", [*DEFER, *GAP_DEFER, *HAZARD_DEFER])
def test_anything_not_provably_read_only_is_refused(command):
    assert ansible_readonly_safe(command) is False


# --- Hazard 2: the trailing-suffix regex is anchored and narrow — only immediately after
# `2>&1`, only at end of string. The live production shape must keep passing. ---


def test_the_live_production_shape_from_uv_python_sh_is_allowed():
    command = (
        "stdio-blocking; uv run ansible-playbook ansible/deploy.yml "
        "--tags karakeep --check 2>&1 | tail -3"
    )
    assert ansible_readonly_safe(command) is True


def test_a_tail_suffix_not_immediately_after_2_and_1_is_refused():
    # Extra shell structure between `2>&1` and `tail` is not the one recognized shape.
    assert ansible_readonly_safe("ansible-playbook site.yml --check 2>&1 tail -n 5") is False


# --- Hazard 3: -e/--extra-vars values are opaque — skipped entirely from the read-only
# scan, not merely ignored. A bare (unquoted, non-@) value token equal to a read-only flag
# must not itself satisfy the scan. ---


def test_extra_vars_value_equal_to_a_readonly_flag_does_not_count_as_one():
    assert ansible_readonly_safe("ansible-playbook site.yml -e --check") is False


def test_short_attached_extra_vars_at_sign_disqualifies_even_with_check():
    assert ansible_readonly_safe("ansible-playbook site.yml --check -evars.yml@x") is True
    assert ansible_readonly_safe("ansible-playbook site.yml --check -e@vars.yml") is False


# --- Hazard 4: head recognition is positional and runs before any flag scanning. An
# unrecognised head refuses immediately, even carrying a read-only flag. ---


def test_an_unrecognised_head_carrying_a_readonly_flag_is_refused():
    assert ansible_readonly_safe("helm ansible-playbook.sh --check") is False
