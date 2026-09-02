---
paths:
  - "**/*.py"
  - "**/*.pyi"
---
- Use ruff for linting and formatting
- Type hints on function signatures; skip inline variable annotations unless non-obvious
- Tests use pytest; match existing fixture patterns in conftest.py
- Prefer pathlib over os.path

## Comments and docstrings

Adapted from section 3.8 of Google's Python style guide
(<https://google.github.io/styleguide/pyguide.html#s3.8-comments-and-docstrings>). The
shared rules are in `comments.md`.

- **Every docstring is `"""` triple-double-quoted:** a summary line (one line, ends with a
  period, question mark or exclamation mark), a blank line, then the rest at the same indent
  as the opening quotes.
- **A module opens with a docstring** describing its contents and, where it helps, a "Typical
  usage example:" block. A test module's docstring is optional and exists only to say
  something beyond "Tests for foo": special run instructions, setup patterns, an external
  dependency.
- **A function gets a docstring when it is public API, non-trivial in size, or non-obvious
  in logic.** Sections, in this order, each a heading followed by an indented body:
  - `Args:` one entry per parameter, `name: description`, continuation lines indented 2–4
    spaces. Include the type only when there is no annotation.
  - `Returns:` (or `Yields:` for a generator) the semantics and any type information the
    annotation does not carry. Omit it when the function returns `None` or the summary line
    already says what comes back.
  - `Raises:` every exception that is part of the interface, same layout as `Args`. Do not
    list one raised on a violated precondition that the docstring already states.
- **An `@override` method needs no docstring** unless it materially refines the base
  contract; the decorator points the reader at the base class.
- **A class docstring says what an instance represents** and carries an `Attributes:`
  section for public attributes (not properties), in `Args` layout. An `Exception` subclass
  describes what the error represents, not where it is raised. `__init__` documents its
  arguments in its own `Args:`.
- **Implementation comments:** a comment before a complicated block, or at the end of a
  non-obvious line. An inline comment starts at least two spaces after the code, then `#`,
  then one space. Comment the part a reviewer would ask about, and never narrate the code.
- **Write comments as prose,** with capitalisation and punctuation. A complete sentence is
  more readable than a fragment.
- **TODO:** `# TODO: <link> - <explanation>`.
