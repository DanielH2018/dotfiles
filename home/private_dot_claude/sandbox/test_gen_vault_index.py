#!/usr/bin/env python3
"""Standalone tests for gen-vault-index.py (run: python3 test_gen_vault_index.py)."""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, "gen-vault-index.py")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def run_case():
    with tempfile.TemporaryDirectory() as d:
        vault = os.path.join(d, "vault")
        write(os.path.join(vault, "Work", "Glossary.md"),
              "---\ntitle: Glossary\nsummary: Payments jargon\n---\nbody\n")
        write(os.path.join(vault, "Work", "Codebase.md"),
              "---\ntitle: Codebase\nsummary: Repos and tables\n---\nbody\n")
        # Sensitive page NOT allowlisted — must never appear
        write(os.path.join(vault, "Ops", "On_Call.md"),
              "---\ntitle: On-Call\nsummary: AWS account IDs\n---\nbody\n")
        # Auto-load trap — even if listed, must be skipped
        write(os.path.join(vault, "CLAUDE.md"), "---\ntitle: CLAUDE\nsummary: trap\n---\n")

        allowlist = os.path.join(d, "allow.txt")
        write(allowlist, "# comment\nWork/Glossary.md\nWork/Codebase.md\nCLAUDE.md\n\n")

        out = os.path.join(d, "index.md")
        rc = subprocess.run([sys.executable, GEN, vault, allowlist, out]).returncode
        assert rc == 0, f"generator exited {rc}"

        text = open(out, encoding="utf-8").read()
        assert "Glossary" in text, "allowlisted page missing"
        assert "Codebase" in text, "allowlisted page missing"
        assert "On-Call" not in text and "On_Call" not in text, "sensitive page leaked"
        assert "AWS account IDs" not in text, "sensitive summary leaked"
        assert "trap" not in text and "CLAUDE" not in text, "CLAUDE.md not excluded"
        print("ok")


def run_dir_case():
    with tempfile.TemporaryDirectory() as d:
        vault = os.path.join(d, "vault")
        write(os.path.join(vault, "Refs", "Good.md"),
              "---\ntitle: Good Ref\nsummary: safe reference page\n---\nbody\n")
        # Traps inside an allowlisted DIRECTORY — must be skipped by the walk layer
        write(os.path.join(vault, "Refs", "CLAUDE.md"),
              "---\ntitle: CLAUDE\nsummary: dir-walk trap claude\n---\n")
        write(os.path.join(vault, "Refs", "index.md"),
              "---\ntitle: Index\nsummary: dir-walk trap index\n---\n")

        allowlist = os.path.join(d, "allow.txt")
        write(allowlist, "Refs\n")   # directory entry, not a file

        out = os.path.join(d, "index.md")
        rc = subprocess.run([sys.executable, GEN, vault, allowlist, out]).returncode
        assert rc == 0, f"generator exited {rc}"

        text = open(out, encoding="utf-8").read()
        assert "safe reference page" in text, "allowlisted dir page missing"
        assert "dir-walk trap claude" not in text, "CLAUDE.md leaked via dir walk"
        assert "dir-walk trap index" not in text, "index.md leaked via dir walk"
        print("ok (dir)")


if __name__ == "__main__":
    run_case()
    run_dir_case()
