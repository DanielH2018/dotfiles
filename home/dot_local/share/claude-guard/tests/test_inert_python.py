"""inert_python: each way out of the allowlist refuses, and a file-editing program passes."""

import pytest

from claude_guard.inert_python import inert

INERT = [
    "from pathlib import Path\np = Path('a.md')\np.write_text(p.read_text().replace('x', 'y'))",
    "import re, json\nprint(json.dumps(re.findall('a', open('f').read())))",
    "import sys\nfor line in sys.stdin:\n    print(line.strip().upper())",
    "def rep(s, a, b):\n    assert s.count(a) == 1\n    return s.replace(a, b)\nrep('a', 'a', 'c')",
    "s = open('docs/x.md').read()\nprint(s.replace('a', 'sudo -n /usr/local/sbin/x'))",
]
NOT_INERT = [
    # an import outside the closed set
    "import os\nos.system('id')",
    "import subprocess\nsubprocess.run(['id'])",
    "import yaml\nyaml.unsafe_load('x')",
    "from os import system\nsystem('id')",
    "import os.path",
    "from pathlib import *",
    # an attribute outside the closed set, which reaches os from an allowed module
    "import pathlib\npathlib.os.system('id')",
    "import sys\nsys.modules['os'].system('id')",
    "print(().__class__.__bases__)",
    # a builtin that loads or looks up code
    "__import__('os').system('id')",
    "getattr(print, 'x')",
    "exec('print(1)')",
    "help('modules')",
    # a file a later shell, git or Claude Code runs, or /proc
    "open('/home/u/.bashrc', 'a').write('id')",
    "open('/home/u/.claude/settings.json', 'w').write('{}')",
    "open('/proc/self/mem', 'wb')",
    "open('/home/u/.local/bin/git', 'w').write('id')",
    # text that is not Python
    "if x then echo; fi",
]


@pytest.mark.parametrize("program", INERT)
def test_a_program_that_only_reads_and_writes_text_is_inert(program):
    assert inert(program)


@pytest.mark.parametrize("program", NOT_INERT)
def test_a_program_outside_the_allowlist_is_not_inert(program):
    assert not inert(program)
