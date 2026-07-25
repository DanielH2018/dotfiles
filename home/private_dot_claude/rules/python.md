---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
- Use ruff for linting and formatting
- Type hints on function signatures; skip inline variable annotations unless non-obvious
- Tests use pytest; match existing fixture patterns in conftest.py
- Prefer pathlib over os.path
