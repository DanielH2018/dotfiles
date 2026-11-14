"""inert_python: each way out of the allowlist refuses, and a file-editing program passes."""

import pytest

from claude_guard.inert_python import call_arguments, inert, literal_words, read_only

INERT = [
    "from pathlib import Path\np = Path('a.md')\np.write_text(p.read_text().replace('x', 'y'))",
    "import re, json\nprint(json.dumps(re.findall('a', open('f').read())))",
    "import sys\nfor line in sys.stdin:\n    print(line.strip().upper())",
    "def rep(s, a, b):\n    assert s.count(a) == 1\n    return s.replace(a, b)\nrep('a', 'a', 'c')",
    "s = open('docs/x.md').read()\nprint(s.replace('a', 'sudo -n /usr/local/sbin/x'))",
    # the edit idiom that rebinds a module-level text
    "s = open('f').read()\ndef rep(a, b):\n    global s\n    s = s.replace(a, b)\nrep('x', 'y')",
    # each shape of a write whose destination is a data-file literal
    "open('/tmp/x.md', 'w').write('run sudo')",
    "import pathlib\npathlib.Path('a.json').write_text('{}')",
    "import json\nwith open('out.json', 'w') as f:\n    json.dump({}, f)",
    "from pathlib import Path\nPath('b.md').replace('a.md')",
    "from pathlib import Path\nwith Path('a.log').open('a') as f:\n    f.write('x')",
]
PY = "from pathlib import Path\n"
NOT_A_DATA_FILE = [
    # a module the program could then import
    PY + "Path('json.py').write_text('import os')\nimport json",
    "open('_strptime.py', 'w').write('import os')",
    PY + "Path('a.md').rename('json.py')",
    PY + "Path('a.md').copy('json.py')",
    # a path that is not one string literal
    "open('json' + '.md', 'w').write('x')",
    PY + "(Path('lib') / 'json' / '__init__.py').write_text('x')",
    PY + "Path('a.md').with_suffix('.py').write_text('x')",
    PY + "for p in Path('.').rglob('*.md'):\n    p.write_text('x')",
    "import sys\nopen(sys.argv[1], 'w').write('x')",
    # a name bound more than once, or by something other than `Path(…)` of a literal
    PY + "p = Path('a.md')\np = Path('json.py')\np.write_text('x')",
    PY + "p = Path('a.md')\ndef f(p):\n    p.write_text('x')",
    "import pathlib\ndef Path(x):\n    return pathlib.Path('j.py')\nPath('a.md').write_text('x')",
    # a writer that is passed, aliased or called on the class
    "o = open\no('a.md', 'w')",
    PY + "w = Path('a.md').write_text\nw('x')",
    PY + "Path.rename('a.md', 'json.py')",
    PY + "class P(Path):\n    pass\nP('a.md').touch()",
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


@pytest.mark.parametrize("program", NOT_A_DATA_FILE)
def test_a_write_that_is_not_to_a_data_file_literal_is_not_inert(program):
    assert not inert(program)


@pytest.mark.parametrize("program", NOT_INERT)
def test_a_program_outside_the_allowlist_is_not_inert(program):
    assert not inert(program)


@pytest.mark.parametrize(
    ("program", "words"),
    [
        ("run(['git'] + a)\na = ['push', b'--force']", {"git", "push", "--force"}),
        ("run(['pu' + 'sh', 'a' + 'b' + 'c'])", {"pu", "sh", "push", "a", "b", "c", "ab", "abc"}),
        ("p = 'pu'\nrun(p + 'sh')", {"pu", "sh", "push"}),
        ("run('git push ' + flag, shell=True)", {"git", "push"}),
        # A name bound twice, or to itself, has no one value to fold.
        ("p = 'pu'\np = 'x'\nrun(p + 'sh')", {"pu", "x", "sh"}),
        ("p = p + 'sh'", {"sh"}),
        ("run(['git'", set()),
        ("run('a b' + 'c d' + ' e')", {"a", "b", "c", "bc", "d", "e"}),
    ],
)
def test_literal_words_folds_concatenation_and_names_bound_once(program, words):
    assert literal_words(program) == words


def test_literal_words_folds_a_chain_of_any_length():
    assert "ab" in literal_words("x = " + "'' + " * 5000 + "'a' + 'b'")


def test_literal_words_leaves_out_a_word_a_name_doubles_past_the_limit():
    doubling = "\n".join(f"x{i + 1} = x{i} + x{i}" for i in range(64))
    assert literal_words(f"x0 = 'ab'\n{doubling}") == {"ab" * 2**n for n in range(13)}


@pytest.mark.parametrize(
    ("program", "calls"),
    [
        ("run(['git'] + a)\na = ['push', b'-f']", [["git", "push", "-f"]]),
        ("run(['git', *['push', 'pu' + 'sh']], check=True)", [["git", "push", "push"]]),
        ("b = 'main'\nrun(['git', f'{b}:{c}'])", [["git", "main:"]]),
        ("run('a b'.split(), env={'HOME': '/x', **e, k: 'v'})", [["a b", "HOME=/x", "v"]]),
        ("run(['git', 'fetch']); run(['ls', '-l'])", [["git", "fetch"], ["ls", "-l"]]),
        ("run(x(['git', '-C']), 'push')", [["git", "-C", "push"], ["git", "-C"]]),
        # A name bound twice has no one value, and a name bound to itself adds nothing.
        ("a = ['push', '-f']\na = ['log']\nrun(['git'] + a)", []),
        ("a = a + ['push']\nrun(['git'] + a)", [["git", "push"]]),
    ],
)
def test_call_arguments_keeps_the_literals_of_each_call_apart(program, calls):
    found = [words for words in call_arguments(program) if len(words) > 1]
    assert sorted(found) == sorted(calls)


def test_call_arguments_lists_each_string_literal_on_its_own():
    assert call_arguments("c = 'git push'\nd = ['-f']") == [["git push"], ["-f"]]


def test_call_arguments_folds_a_chain_of_any_length():
    assert ["ab"] in call_arguments("run(" + "'' + " * 5000 + "'a' + 'b')")


@pytest.mark.parametrize(
    "program",
    [
        "run(['git'",
        "x0 = ['ab']\n" + "\n".join(f"x{i + 1} = x{i} + x{i}" for i in range(64)) + "\nrun(x64)",
        "x0 = 'ab'\n" + "\n".join(f"x{i + 1} = x{i}" for i in range(5000)) + "\nrun(x5000)",
    ],
)
def test_call_arguments_is_none_for_a_program_it_cannot_read(program):
    assert call_arguments(program) is None
