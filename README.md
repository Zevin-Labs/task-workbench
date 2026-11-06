# Task Workbench · Idea Pool · Reviews for DeepSeek Harness

[![CI](https://github.com/Zevin-Labs/task-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/Zevin-Labs/task-workbench/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-task-workbench)](https://www.npmjs.com/package/dsh-task-workbench)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> A local-first **task manager, idea pool and daily/weekly/monthly review** built as a DeepSeek Harness plugin.
> Sidebar entry with four tabs — **Today**, **This week**, **Tasks** and **Ideas** — plus a review area at the bottom of the Today view.
> Tasks can be **single-day** or **multi-day** (start date → end date) with **optional times**; no recurrence rules, projects, lunar calendar or push reminders.
> Ideas have **four states** (todo / doing / done / dropped), **three maturity levels** (low / medium / high), a **multi-line description** and an optional category. Only a human can change an idea's state.
> Reviews are **daily / weekly / monthly**: the daily review is written for today; the weekly review appears Monday–Sunday and covers the previous calendar week; the monthly review appears on the last day of the month and covers that month (can still be written on the 1st–3rd of the next month). **Review prose is human-only; agents can read it, never write it.**
> The source of truth is the plugin's own data root (default `$DSH_HOME/task-workbench/data`, not in Git): tasks are sharded by month, ideas and reviews live in single long-lived files.

[中文 README](README.zh-CN.md)

## Status

**Open-sourced on GitHub on 2026-11-06.** Current version: `0.5.0` — the repository/package were renamed from `personal-task-workbench` and the agent tools from `ptw_*` to `tw_*`. npm publication of `dsh-task-workbench@0.5.0` is pending.
**V3.0 is implemented and accepted with real GUI clicks + agent tool integration on DSH desktop** (2026-11-05).
Tests: 89 passing with no runtime dependencies and no build step. The full suite is a release/CI gate; day-to-day changes run only the targeted domain tests (see [`docs/05-协作与测试.md`](docs/05-协作与测试.md)).

> V3.0 adds the review area at the bottom of the Today view (daily / weekly / monthly, human-written, agent-read-only) and a separate review domain (`ReviewService`, `/tw/api/reviews*`, `tw_review_*` read-only tools).
> V2.0 added the idea pool (single file, four states, three maturity levels, multi-line descriptions, human-only state changes).
> The UI is currently Chinese-only; the plugin, its files and this README are language-agnostic.

## Install

Requirements: DSH **`>=0.2.2-rc.1 <0.3.0`**, Node **>=24**. The plugin has no build step and no runtime dependencies.

**From npm (recommended):**

```sh
dsh plugin --profile <profile> add dsh-task-workbench
```

On desktop you can also use the GUI: **Plugins → Add plugin** and enter the package name `dsh-task-workbench`.

**From GitHub:** in the desktop app open **Plugins → Add plugin** and paste the repository URL, or use the CLI:

```sh
dsh plugin --profile <profile> add github:Zevin-Labs/task-workbench
```

**From the release tarball** (prebuilt; no build approval needed): download
`dsh-task-workbench-0.5.0.tgz` from the [v0.5.0 release](https://github.com/Zevin-Labs/task-workbench/releases/tag/v0.5.0), then:

```sh
dsh plugin --profile <profile> add /path/to/dsh-task-workbench-0.5.0.tgz
```

**From a local checkout:**

```sh
git clone https://github.com/Zevin-Labs/task-workbench.git
dsh plugin --profile <profile> add /absolute/path/to/task-workbench
```

Then open **Task Workbench** in the sidebar. The first open walks you through initializing the data root.

## What you get

1. **Today** — overdue unfinished tasks, tasks due today (including multi-day tasks currently in range) and tasks completed today (check to undo). The bottom of the page is the **review area**.
2. **This week** — a natural week (Monday–Sunday) as seven columns; single-day tasks land on their date; multi-day tasks are collected in one summary bar of chips (title + range + priority dot), and hovering a chip highlights the matching day columns. Today is highlighted.
3. **Tasks** — the current month's list, filterable by keyword / state / priority; the date column shows the time or range.
4. **Ideas** — the idea pool. The state counters at the top filter on click; the toolbar searches name/description, filters by maturity/category and switches sorting; the state can be changed directly on a card, and the title opens detail/edit.
5. **New task** — single-day (date + optional time) or multi-day (start → end, end must be later than start, optional start/end times); four-quadrant priority + one-line note; saving writes straight back to Markdown.
6. **New idea** — the name is required; multi-line description, maturity (low by default) and category are optional; the state starts at `todo` and is changed from the list later.
7. **Reviews** (bottom of Today, human-only):
   - **Daily** — one input per day for today; after submitting it renders in place and can be edited or cleared.
   - **Weekly** — appears during the current week and covers the **previous calendar week**; the block can expand "last week's material" (completed / overdue tasks + that week's daily reviews) and turns into a read view once written.
   - **Monthly** — appears on the **last day of the month** (28/29/30/31 as applicable) and covers the month; it can still be written on the 1st–3rd of the next month, with the month's task summary and weekly reviews as material.
   - Reviews outside their writable window are read-only (edit the Markdown directly for history); all three can be edited in place and cleared (second confirmation + backup before writing).
8. **Edit / delete / complete** — inline task operations; multi-day and single-day can be converted into each other; delete is a hard delete (second confirmation + automatic backup before writing). Idea edit/delete is in a modal; state changes happen on the card pill or in the modal.
9. **Agents** can read tasks, create/edit/delete tasks (`tw_*`), read ideas, create/edit idea content and delete ideas (`tw_idea_*`), and **read** reviews (`tw_review_list` / `tw_review_get`). **Completing/uncompleting tasks, changing idea states and writing review prose are human-only** — no agent write tool exists. The plugin ships a `task-workbench` skill that tells the agent which tools to use.

## Data layout

```text
data root (default $DSH_HOME/task-workbench/data)
├── 任务清单/YYYY-MM.md    the only writable task shard for the month: ## 任务 / ## 已完成
├── 想法池/想法池.md       single idea file: ## 想法 + idea blocks (metadata line + indented description)
├── 复盘/日复盘.md         single daily-review file: ## 记录 + review blocks (period key + 2-space-indented prose)
├── 复盘/周复盘.md         single weekly-review file (key = that week's Monday)
├── 复盘/月复盘.md         single monthly-review file (key = YYYY-MM)
└── 备份/<YYYY-MM-DD>/     per-write backups (tasks / ideas / daily / weekly / monthly; kept 7 days by default, `backupRetentionDays` 1–90)
```

- Task line: ``- [ ] `T-20261105-01`｜Workbench dev｜日期：2026-11-05｜时间：09:30｜结束日期：2026-11-12｜结束时间：18:00｜优先级：重要紧急``
- Idea line: ``- `I-20261105-01`｜Quarterly review notes｜状态：推进中｜成熟度：高｜分类：工作｜创建：2026-11-03｜更新：2026-11-06``, with the description on the following lines indented by two spaces.
- Review block: `- \`2026-11-05\`｜更新：2026-11-05 22:05`, with the prose on the following lines indented by two spaces (blank lines separate paragraphs).
- The values written to Markdown and accepted by the agent tools are the Chinese enums: priority `重要紧急 / 重要不紧急 / 不重要紧急 / 不重要不紧急`; idea status `待实现 / 推进中 / 完成 / 放弃`; maturity `低 / 中 / 高`. The English labels above are translations.
- Moving machines / backup: copy the whole data root. Two machines do not share data by default.
- It does not scan other workspaces, note vaults or Daily systems, and imports nothing.
- Plugin state lives in `$DSH_HOME/task-workbench/` (`settings.json` / `ids.json` / `idea-ids.json` / `writes.log`) and never holds task/idea/review data.

## Privacy and permission boundary

- **No external network requests**: the plugin only talks to its own same-origin local API (`/tw/api`) and reads/writes local Markdown with `node:fs` inside the Host process.
- Data stays in the local data root and `$DSH_HOME/task-workbench/`, never inside the plugin install directory, so upgrades and reinstalls cannot lose it.
- Agents and the UI share the same service, write gateway, queue, backup and audit log (`writes.log`) — there is no second write path.
- **Completing/uncompleting tasks, changing idea states and writing reviews are human-only**: there is no agent tool for them, and the service layer returns `permission-denied` for non-user actors.
- Deletes are hard deletes with an automatic pre-write backup kept for 7 days by default (configurable 1–90 via `backupRetentionDays`).

## Code layout

```text
lib/
├── index.js          # Host entry: TaskStore/TaskService + IdeaStore/IdeaService + ReviewStore/ReviewService + routes + agent tools
├── client.js         # Client entry: sidebar icon + native React panel (hand-written lazy-CJS, no build)
├── core/             # task / idea / review contract, grammar, derive, validate, window (pure functions)
└── host/             # settings / writer / gateway / http / store / service / routes / tools (one set per domain)
skills/               # bundled `task-workbench` skill (how agents should use the tools)
tests/                # core / service / routes / tools / wiring / settings / skills — temp data roots only
docs/                 # feature spec + implementation architecture + architecture diagram + collaboration/testing guide (Chinese)
```

## Development

```bash
git clone https://github.com/Zevin-Labs/task-workbench.git
cd task-workbench
npm run check                      # syntax only
npm run test:task                  # targeted example: task domain (33 tests)
npm test                           # full 89-test suite — pre-release / CI only
```

- **Targeted by default**: run the test file(s) for the domain you touched; the change → test matrix is in [`docs/05-协作与测试.md`](docs/05-协作与测试.md). The full suite runs before a release, for cross-cutting changes, and in CI — not for every small edit.
- Automated tests only ever use `os.tmpdir()` data roots and **never touch real `data/`**.
- Host code changes: toggle the "Task Workbench" component off/on in the Plugins page, or restart the app.
- Client code changes: refresh the page (the client bundle is hot-replaced by DSH HMR).
- To keep development data inside the repo, point `dataRoot` in `$DSH_HOME/task-workbench/settings.json` at the repo's `data/` (gitignored).
- Typical loop: make the change → targeted tests → local `git commit` (do not push) → publish a batch with [`docs/04-发布与更新.md`](docs/04-发布与更新.md).

## Scope

- **In scope**: Today / This week (natural week) / all-tasks views; single-day and multi-day tasks; optional times; view, create, edit, delete, complete/undo; four-quadrant priority; note. Idea pool: list/filter/search, create, edit content, change state, delete, four states, three maturity levels, multi-line description, optional category. Reviews: daily/weekly/monthly, submit/edit/clear inside the writable window, weekly/monthly material, agent read-only.
- **Out of scope**: knowledge-base/Daily scanning, fixed routine rules, project directions, recurrence rules, lunar calendar, push reminders, agent claiming/acceptance, old-data migration, historical month browsing; **idea → task conversion, idea kanban, automatic archiving**; **review history tab, agent-written reviews, backfilling older periods, review charts**.
- Delete is a hard delete (backups, no recycle bin); reviews are read-only once their window closes; external edits are picked up by a 5-second poll, and writes use `baseHash` to avoid clobbering them.
- Single process, single user; concurrent writes from multiple windows are not handled (`baseHash` conflicts are rejected).

## Docs

- Docs index (Chinese): [`docs/README.md`](docs/README.md)
- Feature spec: [`docs/01-功能规格.md`](docs/01-功能规格.md)
- Implementation architecture: [`docs/02-实现架构.md`](docs/02-实现架构.md)
- Architecture diagram: [`docs/03-整体架构图.html`](docs/03-整体架构图.html) · [screenshot](docs/acceptance/架构图.png)
- Collaboration & testing (agent onboarding, data-contract → test map, config layers, targeted-test rules): [`docs/05-协作与测试.md`](docs/05-协作与测试.md)
- Release & update runbook (Chinese): [`docs/04-发布与更新.md`](docs/04-发布与更新.md)
- Contribution rules: [`CONTRIBUTING.md`](CONTRIBUTING.md)

## License

[MIT](LICENSE)
