# Contributing

Thanks for taking a look. This is a small, dependency-free DeepSeek Harness plugin; the bar for changes is "read right, write right, don't lose data".

## Before you start

- Read [`AGENTS.md`](AGENTS.md), [`docs/01-功能规格.md`](docs/01-功能规格.md), [`docs/02-实现架构.md`](docs/02-实现架构.md) and [`docs/05-协作与测试.md`](docs/05-协作与测试.md). They are in Chinese; that is the project's working language for specs and notes. 05 is the fast path: file map, data-contract → test matrix, config layers and the targeted-test rules.
- Keep the scope: task management + idea pool + daily/weekly/monthly reviews. New fields, views or features outside V3.0 should be discussed in an issue first.

## Setup

Requirements: Node 24+ and a DSH build matching `engines.dsh` (`>=0.2.2-rc.1 <0.3.0`).

```sh
git clone https://github.com/Zevin-Labs/task-workbench.git
cd task-workbench
npm run check        # syntax
npm run test:task    # targeted example: run only the domain you touched
npm test            # full suite; for shared changes, CI, and the release gate
```

There is no build step. To run a local checkout inside DSH:

```sh
dsh plugin --profile <profile> add /absolute/path/to/task-workbench
```

## Releasing

Maintainers: the release and update runbook is [`docs/04-发布与更新.md`](docs/04-发布与更新.md) (Chinese).

## Rules

- **Targeted tests by default.** Run the test file(s) for the domain you touched (`npm run test:task|idea|review`, or a single file). CI runs the full suite; maintainers run `npm run verify` once before a release. Do not run the full suite for a small edit and do not repeat it after a targeted pass — see [`docs/05-协作与测试.md`](docs/05-协作与测试.md) for the change → test matrix.
- **Tests never touch real data.** Every test uses a temporary data root under `os.tmpdir()`; do not point tests at `data/` or `$DSH_HOME`.
- **One write path.** UI and agents both go through `TaskService` / `IdeaService` / `ReviewService` to the same SQLite database. Short transactions commit business changes, `write_log` audit entries, and domain versions together; hard deletes and clearing reviews require a validated database snapshot. `WriteGateway` only handles in-process request idempotency and error normalization. Do not add a second write path.
- **Human-only actions stay human-only.** Completing/uncompleting tasks, changing idea states and writing reviews have no agent write tool; the service layer rejects non-user actors with `permission-denied`.
- **No new runtime dependencies** unless there is a strong, documented reason. The plugin currently has zero.
- In a pull request, say what you changed and which targeted tests you ran (with the command and result).

## Reporting bugs

Open an issue with your DSH version (from the app's About or `dsh --version`), the plugin version, what you expected, what happened, and the structured error code/message or a minimal reproduction using temporary data. Remove personal content before pasting; do not attach your database or backups.
