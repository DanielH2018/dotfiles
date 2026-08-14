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

# Mirror of SECRET_PATHS in ~/.claude/hooks/block-dangerous-bash.sh. jsonq opens
# files directly, so without this it would be a way around that hook's guard —
# ~/.claude.json, ~/.docker/config.json and ~/.kube/config are all JSON *and*
# secret. tests/jsonq.test.js asserts the two stay in sync; the only permitted
# difference is POSIX [:space:] rewritten as \s for Python's re.
SECRET_PATHS = (
    r"(\.env|\.ssh/|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config"
    r"|\.gnupg/|\.netrc|\.pypirc|\.npmrc|/secrets/|\.git-credentials"
    r"|\.kube/config|\.docker/config\.json|\.config/gh/hosts\.yml"
    r"|\.claude/\.credentials\.json|\.claude\.json"
    r"|/etc/shadow|/etc/gshadow|/proc/[^/\s]+/environ|\.(pem|key|p12|pfx)\b)"
)
