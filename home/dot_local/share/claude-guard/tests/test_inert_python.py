"""inert_python: each way out of the allowlist refuses, and a file-editing program passes."""

import pytest

from claude_guard.inert_python import inert, read_only

INERT = [
    "from pathlib import Path\np = Path('a.md')\np.write_text(p.read_text().replace('x', 'y'))",
    "import re, json\nprint(json.dumps(re.findall('a', open('f').read())))",
    "import sys\nfor line in sys.stdin:\n    print(line.strip().upper())",
    "def rep(s, a, b):\n    assert s.count(a) == 1\n    return s.replace(a, b)\nrep('a', 'a', 'c')",
    "s = open('docs/x.md').read()\nprint(s.replace('a', 'sudo -n /usr/local/sbin/x'))",
    # the edit idiom that rebinds a module-level text
    "s = open('f').read()\ndef rep(a, b):\n    global s\n    s = s.replace(a, b)\nrep('x', 'y')",
]
NOT_INERT = [
    # a declaration that names a dunder or a builtin outside the set
    "def f():\n    global __builtins__\n    __builtins__ = 1",
    "def f():\n    global exec\n    exec = print",
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
    "open('/home/u/.zshenv', 'a').write('id')",
    "open('/home/u/.ssh/config', 'a').write('ProxyCommand id')",
    "open('/home/u/.config/git/config', 'a').write('[core]')",
    "open('.mcp.json', 'w').write('{}')",
    # text that is not Python
    "if x then echo; fi",
]


READ_ONLY = [
    "print(open('/home/u/.bashrc').read())",
    "import json\nprint(json.load(open('/home/u/.claude/settings.json', 'rb'))['hooks'])",
    "from pathlib import Path\nprint(Path('.zshrc').read_text().splitlines()[:3])",
    "from pathlib import Path\nwith Path('.zshrc').open() as f:\n    print(f.read())",
    "from pathlib import Path\nprint(Path('.zshrc').open('r', encoding='utf-8').read())",
    "print(open('.zshrc', mode='rt', encoding='utf-8').read())",
]
NOT_READ_ONLY = [
    # an attribute that changes a file on some object
    "from pathlib import Path\nPath('.zshrc').write_text('x')",
    "from pathlib import Path\nPath('x').replace('.zshrc')",
    "from json import dump\ndump({}, f)",
    # the builtin takes the mode second, or as a keyword
    "open('.zshrc', 'w')",
    "open('.zshrc', 'r+')",
    "open('.zshrc', mode='a')",
    "open('.zshrc', m)",
    "open(*args)",
    "open('.zshrc', **kwargs)",
    # `Path('f').open` takes the mode first
    "from pathlib import Path\nPath('.zshrc').open('w')",
    "from pathlib import Path\nPath('.zshrc').open(m)",
    # the unbound `Path.open`, like `gzip.open`, takes the path first and the mode second
    "from pathlib import Path\nPath.open(Path('.zshrc'), 'w')",
    # an `open` that is not called where it is named
    "o = open\no('.zshrc', 'w')",
    "from pathlib import Path\nf = Path('.zshrc').open\nf('w')",
    # outside the allowlist `inert` shares
    "import gzip\ngzip.open('.zshrc')",
]


@pytest.mark.parametrize("program", READ_ONLY)
def test_a_program_that_opens_files_only_for_reading_is_read_only(program):
    assert read_only(program)


@pytest.mark.parametrize("program", NOT_READ_ONLY)
def test_a_program_that_may_change_a_file_is_not_read_only(program):
    assert not read_only(program)


@pytest.mark.parametrize("program", INERT)
def test_a_program_that_only_reads_and_writes_text_is_inert(program):
    assert inert(program)


@pytest.mark.parametrize("program", NOT_INERT)
def test_a_program_outside_the_allowlist_is_not_inert(program):
    assert not inert(program)
