"""Constants: resource caps, and the secret-path pattern jsonq
refuses to read."""

PROG = "jsonq"
MAX_OUTPUT_BYTES = 10 * 1024 * 1024
DEFAULT_TIMEOUT = 5

# Resource caps. These are the residual risk of an interpreter, standing in for
# the sandbox-escape risk of a validator: a single C-level operation cannot be
# interrupted by SIGALRM (the handler only runs between bytecodes), so `2**10**9`
# would sail past --timeout and take the machine's memory with it. Each cap
# below guards an operation that turns a short expression into unbounded work.
MAX_INT_BITS = 1 << 14  # result width of ** and <<; ~4900 digits, already absurd
MAX_INT_DIGITS = 4300  # int("9"*n) is quadratic; CPython 3.11 picked this number
MAX_SEQUENCE = 10_000_000  # elements produced by `seq * n` or range()
MAX_DEPTH = 200  # interpreter nesting, kept under CPython's own recursion limit
MAX_SOURCE_BYTES = 200_000  # ast.parse is recursive; do not hand it a novel

# Mirror of the secret table, claude-guard's claude_guard/secret_paths.json, which
# builds SECRET_PATHS for claude_guard.deny (the PreToolUse deny rules). jsonq opens
# files directly, so without this it would be a way around that guard: ~/.claude.json,
# ~/.docker/config.json and ~/.kube/config are all JSON *and* secret.
# tests/jsonq.test.js asserts this carries exactly the table's fragments, in any order,
# since jsonq refuses on any match. The only permitted difference is POSIX [:space:]
# rewritten as \s for Python's re. A literal copy rather than a read of the table: the
# package directory has no Edit protection, and a jsonq that cannot find the table must
# not stop refusing.
SECRET_PATHS = (
    r"((?<!process)(?<!\.\.)\.env(?!iron(?:ments?|b)?\b)(?!\.(?:example|sample|template)(?![A-Za-z0-9_./-]))(?!(?<=[A-Za-z0-9_-]\.env)\.j2(?![A-Za-z0-9_./-]))|\.ssh/|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config"
    r"|\.gnupg/|\.netrc|\.pypirc|\.npmrc"
    r"|/run/secrets/|/run/credstore/|/homelab-secrets/|/libvirt/secrets/|\.git-credentials"
    r"|\.kube/config|\.docker/config\.json|\.config/gh/hosts\.yml"
    r"|\.claude/\.credentials\.json|\.claude\.json"
    r"|/etc/shadow|/etc/gshadow|/proc/[^/\s]+/environ"
    r"|(^|[A-Za-z0-9_~/-])\.(pem|key|p12|pfx)\b"
    r"|(^|[A-Za-z0-9_~/-])\.secret\b"
    r"|\.config/sops/age/|(^|[A-Za-z0-9_~/-])\.agekey\b"
    r"|\.config/gcloud/)"
)
