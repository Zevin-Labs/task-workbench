# Task Workbench · Idea Pool · Reviews

A local DeepSeek Harness plugin for tasks, ideas, and daily/weekly/monthly reviews. Tasks can be single-day or multi-day, with optional times. Ideas support four states, three maturity levels, and multi-line descriptions. People write reviews; the AI can only read them.

All current data lives in one local SQLite database. The published npm 0.5.0 release used Markdown and is a historical version. Current code does not read or import legacy Markdown.

## Current status

The current published version is [npm 0.6.1](https://www.npmjs.com/package/dsh-task-workbench/v/0.6.1) / [GitHub Release v0.6.1](https://github.com/Zevin-Labs/task-workbench/releases/tag/v0.6.1), released on 2026-11-08. The V3.0 product rules remain in place. It uses Node's built-in node:sqlite and stores the database as workbench.sqlite in the data root. Version 0.5.0 remains the historical Markdown release. Initialization creates an empty database and imports nothing. Legacy test data was privately archived; no machine path is documented.

Requires Node >=24. The DSH engine range is in package.json. There is no build step or third-party runtime dependency.

## Install

Install from npm:

    dsh plugin --profile <profile> add dsh-task-workbench

Or install from GitHub:

    dsh plugin --profile <profile> add github:Zevin-Labs/task-workbench

Open “Task Workbench” in the sidebar. Initialize the empty database in the UI on first use.

## Use

1. **Today** shows overdue, today’s open, and today’s completed tasks; the review area is at the bottom.
2. **This week** shows Monday through Sunday with multi-day tasks drawn as colored tracks into the seven day cards. Below the board, a week/month overview (segmented completion ring) and a read-only month calendar with month navigation; clicking a date opens that day’s tasks, where a task can be edited or a new one added for that date.
3. **Tasks** lists all open tasks and completed tasks from the current month, with keyword, status, and priority filters.
4. **Ideas** provides state counts and filters, search, maturity and category filters; people can change states.
5. **Reviews** can be written, edited, or cleared inside their writable windows. The review area has a simple read-only period lookup for history.
6. **AI** has 14 tools: 7 task tools, 5 idea tools, and 2 read-only review tools. AI can manage task and idea content. People alone complete tasks, change idea states, and write review prose.

Date rules are unchanged: daily reviews cover today; weekly reviews cover the previous natural week and are available Monday–Sunday; monthly reviews cover the current month and are available on the last day through the 3rd of the next month.

## Data and privacy

- The database is workbench.sqlite in the data root. By default this is DSH_HOME/task-workbench/data; settings.json can override dataRoot.
- It contains tasks, ideas, reviews, write_log, and the internal meta table. settings.json stores only dataRoot and backupRetentionDays; initialization state is determined from the database.
- UI and AI tools call the domain services and use the same database. Short SQLite transactions commit business changes, the audit row, and the domain version together. Requests may include baseVersion to reject stale updates.
- A task spanning months remains one database record. Completed tasks from prior months are read-only.
- Before a hard delete or clearing a review, the plugin creates and validates a SQLite snapshot. Backups default to 7 days and backupRetentionDays can be set from 1 to 90.
- The plugin does not scan knowledge bases, Daily systems, or external notes, make external network requests, or import legacy Markdown. The data root is independent of plugin installation. Back up and copy the database when moving machines.
- Task and idea IDs are stable sequential IDs such as T-1 and I-1. Future time-block planning and human/AI collaboration are not implemented; no future fields or tools are pre-created.

## Development

    npm run check
    npm run test:task
    npm run test:idea
    npm run test:review
    npm run test:cross

Tests use temporary data roots under os.tmpdir() and never touch real user data. Use the test group for the changed domain; the full suite is reserved for releases, cross-domain shared changes, and CI.

Reload the plugin after Host changes and refresh the page after Client changes. Use an isolated temporary dataRoot for development tests.

## Scope

**Included:** Today / This week / task list; single-day and multi-day tasks; optional times; view, create, edit, delete, complete/undo; week/month overview and read-only month calendar on the week page; idea list, search, filters, and state management; daily/weekly/monthly reviews, review materials, and read-only historical lookup.

**Not included:** task month-history browser, legacy Markdown import, recurrence, reminders, idea-to-task conversion, kanban, automatic archiving, review statistics, older-period backfilling, time-block matching, or AI claiming/execution/review workflows.

## Docs

- [Documentation index](docs/README.md)
- [Feature specification](docs/01-功能规格.md)
- [Implementation architecture](docs/02-实现架构.md)
- [Architecture diagram](docs/03-整体架构图.html)
- [Collaboration and testing](docs/05-协作与测试.md)
- [Release and update guide](docs/04-发布与更新.md)
- [Contribution rules](CONTRIBUTING.md)

## License

[MIT](LICENSE)
