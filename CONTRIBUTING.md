# Contributing

Thanks for taking a look. This is a small, dependency-free DeepSeek Harness plugin; the bar for changes is "read right, write right, don't lose data".

## Before you start

- Read [`AGENTS.md`](AGENTS.md), [`docs/01-功能规格.md`](docs/01-功能规格.md) and [`docs/02-实现架构.md`](docs/02-实现架构.md). They are in Chinese; that is the project's working language for specs and notes.
- Keep the scope: task management + idea pool + daily/weekly/monthly reviews. New fields, views or features outside V3.0 should be discussed in an issue first.

## Setup

Requirements: Node 24+ and a DSH build matching `engines.dsh` (`>=0.2.2-rc.1 <0.3.0`).

```sh
git clone https://github.com/Zevin-Labs/personal-task-workbench.git
cd personal-task-workbench
node --check lib/index.js && node --check lib/client.js
node --test tests/*.test.mjs
```

There is no build step. To run a local checkout inside DSH:

```sh
dsh plugin --profile <profile> add /absolute/path/to/personal-task-workbench
```

## Rules

- **Tests never touch real data.** Every test uses a temporary data root under `os.tmpdir()`; do not point tests at `data/` or `$DSH_HOME`.
- **One write path.** UI and agents both go through `TaskService` / `IdeaService` / `ReviewService` and the shared `WriteGateway` (queue, idempotency, audit, pre-write backup). Do not add a second write path.
- **Human-only actions stay human-only.** Completing/uncompleting tasks, changing idea states and writing reviews have no agent write tool; the service layer rejects non-user actors with `permission-denied`.
- **No new runtime dependencies** unless there is a strong, documented reason. The plugin currently has zero.
- Run the full test suite before opening a pull request and say in the PR what you changed and what you ran.

## Reporting bugs

Open an issue with your DSH version (from the app's About or `dsh --version`), the plugin version, what you expected, what happened, and the relevant Markdown snippet if data is involved. Remove personal task/idea content before pasting.
