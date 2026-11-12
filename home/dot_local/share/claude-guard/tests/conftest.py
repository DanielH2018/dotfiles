import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).resolve().parents[4] / ".chezmoitemplates" / "settings.permissions.json"


@pytest.fixture
def scratch_dir():
    """A fresh directory under /tmp, the scratch root every test's ROOTS carries.

    pytest's tmp_path sits outside /tmp on macOS. The system temp dir is used when it
    resolves under /tmp (a sandboxed session's $TMPDIR, Linux's default), since a sandbox
    may refuse a write to /tmp itself.

    Windows has no /tmp that Python can create a directory in (`/tmp` resolves to `C:\\tmp`),
    so every test that needs a scratch root is skipped there."""
    if sys.platform == "win32":
        pytest.skip("no /tmp scratch root on Windows")
    base = tempfile.gettempdir()
    real_tmp = os.path.realpath("/tmp")
    real_base = os.path.realpath(base)
    if real_base != real_tmp and not real_base.startswith(real_tmp + "/"):
        base = "/tmp"
    d = tempfile.mkdtemp(dir=base)
    yield d
    shutil.rmtree(d)


@pytest.fixture
def template_permissions() -> dict:
    """settings.permissions.json as written, with its `{{/* */}}` comments removed and its
    `{{ if }}` guards opened, which is the view every host but daniel-box renders."""
    text = re.sub(r"\{\{/\*.*?\*/\}\}", "", TEMPLATE.read_text(), flags=re.DOTALL)
    text = re.sub(r"\{\{-?\s*(if\b[^}]*|end)\s*-?\}\}", "", text)
    return json.loads(text)
