---
paths:
  - "**/*.sql"
  - "**/migrations/**"
  - "**/migration/**"
  - "**/db/migrate/**"
---
- Every migration must be reversible: provide a down migration, or split destructive changes (drop / rename / type change) into expand → migrate → contract deploys.
- Keep each migration idempotent; wrap DDL in an explicit transaction where the runner allows it.
- Create indexes with `CREATE INDEX CONCURRENTLY` (runs outside a transaction) so writes aren't blocked.
- Never add `NOT NULL` or a new foreign key to a populated table without a default/backfill first — it takes a lock and can fail existing rows.
- Batch large backfills; avoid long-running transactions and exclusive locks on hot tables.
- Before merging, run the `migration-reviewer` agent for the full locking / rollback / PCI review — don't restate that checklist here.
- `stop-checks.py` blocks once per session that wrote a migration naming no down step or reversibility (an `.up.sql` needs its `.down.sql`), or that dispatched no `migration-reviewer`.
- To enforce reversibility at merge time, a project repo with migrations calls the dotfiles reusable workflow. It fails a PR that adds a migration with no down step:

  ```yaml
  jobs:
    migration-gate:
      uses: DanielH2018/dotfiles/.github/workflows/migration-gate.yml@<full commit sha>
      # with:
      #   paths: |          # default: **/migrations/**, **/migration/**, **/db/migrate/**
      #     db/schema/**
  ```

  Pin a full commit SHA, which also pins the gate's script. The dotfiles file `.github/migration-gate/migration_gate.py` documents what counts as a down step for each migration shape: paired `.sql` files, dbmate and goose sections, Flyway undo files, Alembic `downgrade()`, Rails `down`/`change`, and knex/TypeORM `down`. To mark a migration irreversible on purpose, add the comment line `-- migration-gate: irreversible: <reason>` (or with `#` or `//`).

## Comments

Google publishes no SQL style guide. These rules apply `comments.md` to migrations and
queries.

- **A migration file opens with a header comment** stating the intent in one sentence, the
  ticket or PR it belongs to, and whether it is reversible. A destructive step names the
  expand → migrate → contract phase it is.
- **Comment the choice, not the statement.** `-- CREATE INDEX CONCURRENTLY` restates the
  DDL; `-- CONCURRENTLY: orders is written every second, an ordinary build would block for
  ~40s` is the comment. The same for a lock, a batch size, a `NOT VALID` constraint, or a
  default chosen to make a backfill safe.
- **A non-obvious `WHERE`, join condition or `CASE` gets a one-line `--` comment above it**
  saying what the rows it selects mean in the domain.
- **Use `--` line comments.** Reserve `/* */` for a block a formatter should re-wrap, and
  never for a hint syntax the engine reads (`/*+ ... */`) unless a hint is meant.
- **TODO:** `-- TODO: <link> - <explanation>`.
