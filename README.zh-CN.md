# 任务工作台 + 想法池 + 复盘（task-workbench）

> 长在 DeepSeek Harness 里的**轻量任务工作台 + 想法池 + 日/周/月复盘**：侧栏入口 + 今日 / 本周 / 任务 / 想法四个 tab，今日页底部是复盘区。
> 任务支持**当天任务**与**跨周期任务**（开始日期 → 结束日期），日期可带**可选时间**（不填 = 全天）；不做重复规则、项目/方向、农历、提醒推送。
> 想法池支持**四态**（待实现 / 推进中 / 完成 / 放弃）、**三档成熟度**（低 / 中 / 高）、**多行详细描述**与可选分类；状态只能由人改。
> 复盘支持**日 / 周 / 月**三类：日复盘每天写今天；周复盘周一至周日写上一个自然周；月复盘在当月最后一天写本月（次月 1–3 日可补写）。**复盘正文只能由人写，AI 只读**。
> 数据真源是工作台自有数据根（默认 `$DSH_HOME/task-workbench/data`，不进 Git）：任务按月分片，想法与复盘单文件长期保留。

[English README](README.md)

## 当前状态

**2026-11-06 已开源到 GitHub**，并发布 npm [`dsh-task-workbench@0.4.0`](https://www.npmjs.com/package/dsh-task-workbench)（[GitHub Release v0.4.0](https://github.com/Zevin-Labs/task-workbench/releases/tag/v0.4.0) 带 tgz）。
**V3.0 已实现，并在 DSH desktop 上完成真实 GUI 点击 + AI 工具联调验收**（2026-11-05）。
测试：89 个用例；全量测试是发版/CI 门禁，日常改动只跑对应域的定向测试（见 [`docs/05-协作与测试.md`](docs/05-协作与测试.md)）。无运行时依赖，无构建步骤。
> V3.0：今日页底部新增**复盘区**（日 / 周 / 月，人写、AI 只读）+ 独立复盘数据域（`ReviewService`、`/ptw/api/reviews*`、`ptw_review_*` 只读工具）。
> V2.0：想法池（独立单文件、四态、三档成熟度、多行描述、状态仅人改）。
> 界面名称统一为「任务工作台」。

## 安装

要求：DSH **`>=0.2.2-rc.1 <0.3.0`**、Node **>=24**。插件无构建步骤、无运行时依赖。

**从 npm（推荐）**：装进对应 profile，重启或刷新即可：

```sh
dsh plugin --profile <profile> add dsh-task-workbench
```

桌面端也可以走 GUI：**插件 → 添加插件**，填包名 `dsh-task-workbench`。

**从 GitHub**：桌面端「插件 → 添加插件」填仓库地址，或用 CLI：

```sh
dsh plugin --profile <profile> add github:Zevin-Labs/task-workbench
```

**从 Release tarball**（预构建，无需构建授权）：从 [v0.4.0 Release](https://github.com/Zevin-Labs/task-workbench/releases/tag/v0.4.0) 下载 `dsh-task-workbench-0.4.0.tgz`，然后：

```sh
dsh plugin --profile <profile> add /path/to/dsh-task-workbench-0.4.0.tgz
```

**从源码 / 本地目录**：

```sh
git clone https://github.com/Zevin-Labs/task-workbench.git
dsh plugin --profile <profile> add /absolute/path/to/task-workbench
```

装好后打开侧栏「**任务工作台**」。首次打开按提示初始化数据根。

## 怎么用

1. 打开 DeepSeek Harness，左侧栏点「**任务工作台**」。
2. **今日**：逾期未完成 + 今天要做（含进行中的跨周期任务）+ 今天已完成（勾选可撤销）；页面底部是**复盘区**。
3. **本周**：自然周（周一至周日）7 列；单日任务按日期落列；跨周期任务收在顶部**一条摘要条**（chips：标题 + 起止日期 + 优先级色点），悬停 chip 时对应日期列高亮；今天高亮。
4. **任务**：当月清单，可按关键词 / 状态 / 优先级筛选；日期列显示时间或区间。
5. **想法**：想法池列表；顶部状态统计可点击筛选；工具栏可搜索名称/描述、按成熟度/分类筛选、切换排序；卡片上可直接改状态，点标题进详情/编辑。
6. **新建任务**：当天（日期 + 可选时间）或跨周期（开始 → 结束，结束必须晚于开始 + 可选开始/结束时间）；可选四象限优先级 + 单行备注；保存即写回 Markdown。
7. **新建想法**：名称必填；可写多行详细描述、选成熟度（默认低）与分类；状态默认「待实现」，之后在列表里改。
8. **复盘**（今日页底部，只能由人写）：
   - **日复盘**：每天一个输入框，写今天；提交后原地展示，可编辑 / 清空。
   - **周复盘**：本周（周一→周日）出现，复盘**上一个自然周**；块里可展开「上周材料」（上周完成 / 到期未完成的任务 + 上周每天的日复盘）；写完变展示态。
   - **月复盘**：**当月最后一天**（28/29/30/31 按实际）出现，复盘本月；次月 1–3 日仍可补写；材料含本月任务概况与本月周复盘。
   - 过了可写窗口的复盘只读（历史内容在 Markdown 里改）；三类都可原地编辑、可清空（二次确认 + 写前备份）。
9. 编辑 / 删除 / 完成：任务行内操作，跨周期与当天可互转；删除为硬删除（二次确认 + 写前自动备份）。想法编辑/删除在弹窗内，改状态在卡片 pill 或编辑弹窗。
10. AI 在会话里可直接读任务、创建/编辑/删除任务（`ptw_*`），读想法、新建/编辑内容/删除想法（`ptw_idea_*`），**只读**复盘（`ptw_review_list` / `ptw_review_get`）；**任务完成/撤销、想法状态、复盘正文都只能由人**（AI 没有对应写工具）。插件同时提供 `task-workbench` 技能，告诉 AI 该走哪些工具。

## 数据目录

```text
数据根（默认 $DSH_HOME/task-workbench/data）
├── 任务清单/YYYY-MM.md    任务当月唯一可写分片：## 任务 / ## 已完成
├── 想法池/想法池.md       想法单文件：## 想法 + 想法块（元数据行 + 缩进描述）
├── 复盘/日复盘.md         日复盘单文件：## 记录 + 复盘块（周期键 + 2 空格缩进正文）
├── 复盘/周复盘.md         周复盘单文件（键 = 该周周一）
├── 复盘/月复盘.md         月复盘单文件（键 = YYYY-MM）
└── 备份/<YYYY-MM-DD>/     写前备份（任务清单-* / 想法池-* / 日复盘-* / 周复盘-* / 月复盘-*；默认保留 7 天，`backupRetentionDays` 可设 1–90）
```

- 任务行示例：``- [ ] `T-20261105-01`｜工作台开发｜日期：2026-11-05｜时间：09:30｜结束日期：2026-11-12｜结束时间：18:00｜优先级：重要紧急``
- 想法行示例：``- `I-20261105-01`｜整理季度复盘｜状态：推进中｜成熟度：高｜分类：工作｜创建：2026-11-03｜更新：2026-11-06``，下一行起用 2 空格缩进写详细描述。
- 复盘块示例：`- \`2026-11-05\`｜更新：2026-11-05 22:05`，下一行起用 2 空格缩进写正文（空行分段）。
- 换机/备份：整个数据根目录拷贝即可；两台机器默认不共享数据。
- 不扫描其他工作区、笔记库或 Daily 系统，不读写、不依赖；不导入旧数据。
- 插件状态在 `$DSH_HOME/task-workbench/`（settings.json / ids.json / idea-ids.json / writes.log），不放任务/想法/复盘数据。

## 隐私与权限边界

- **无外部网络请求**：插件只访问自己的同源本机 API（`/ptw/api`），并用 `node:fs` 在 Host 进程内读写本地 Markdown。
- 数据只落在本机数据根与 `$DSH_HOME/task-workbench/`，不写进插件安装目录，升级/重装不丢。
- AI 与 UI 共用同一套 service / 写网关 / 队列 / 备份 / 审计（`writes.log`），没有第二条写路径。
- **完成/撤销任务、改想法状态、写复盘正文只能由人**：AI 没有对应写工具，service 层对非 user actor 返回 `permission-denied`。
- 删除是硬删除，但写前自动备份，默认保留 7 天（`backupRetentionDays` 可配 1–90）。

## 代码结构

```text
lib/
├── index.js          # Host 入口：装配 TaskStore/TaskService + IdeaStore/IdeaService + ReviewStore/ReviewService + 路由 + AI 工具
├── client.js         # Client 入口：侧栏图标 + 原生 React 主面板（手写 lazy-CJS，无构建）
├── core/             # 任务 / 想法 / 复盘的 contract / grammar / derive / validate / window（纯函数）
└── host/             # settings / writer / gateway / http / store / service / routes / tools（任务 / 想法 / 复盘各一套）
skills/               # 随包统一技能 task-workbench（AI 使用说明）
tests/                # core / service / routes / tools / wiring / settings / skills，全部用临时数据根
docs/                 # 功能规格 + 实现架构 + 架构图 + 协作与测试指南
```

## 开发

```bash
git clone https://github.com/Zevin-Labs/task-workbench.git
cd task-workbench
npm run check                      # 语法检查
npm run test:task                  # 定向示例：任务域（33 个用例）
npm test                           # 全量 89（只在发版前 / 跨域改动 / CI 跑）
```

- **默认定向测试**：改哪个域就跑哪个域的测试文件；改动→测试矩阵见 [`docs/05-协作与测试.md`](docs/05-协作与测试.md)。全量测试只作为发版门禁、跨域改动和 CI 使用，不为小改动跑全量。
- 自动化测试只用 `os.tmpdir()` 临时数据根，**不碰真实 `data/`**。
- 改 host 代码：插件页把「任务工作台」组件关/开一次，或重启 App。
- 改 client 代码：刷新页面（client bundle 由 DSH HMR 热替换）。
- 本地开发想沿用仓库内数据时，把 `$DSH_HOME/task-workbench/settings.json` 的 `dataRoot` 指到仓库 `data/`（已 gitignore）。
- 典型节奏：改代码 → 定向测试 → 本地 `git commit`（不 push）→ 攒一批按 [`docs/04-发布与更新.md`](docs/04-发布与更新.md) 发版。

## 边界

- **做**：今日、本周（自然周）、任务总表；当天/跨周期任务；可选时间；查看、创建、编辑、删除、完成/撤销；四象限优先级；备注。想法池：列表/筛选/搜索、新建、编辑内容、改状态、删除、四态、三档成熟度、多行描述、可选分类。复盘：日/周/月三类、窗口内提交/编辑/清空、周/月材料、AI 只读。
- **不做**：知识库/Daily 扫描、固定动作规则、项目方向、周期任务（重复规则）、农历、提醒推送、AI 认领/验收、旧数据迁移、历史月份浏览；**想法→任务转化、想法看板、想法自动归档**；**复盘历史 tab、AI 写复盘、补写更早周期、复盘统计图表**。
- 删除 = 硬删除（有备份，无回收站）；复盘过了可写窗口即只读；外部改动 5 秒轮询重载，写入用 `baseHash` 防覆盖。
- 单进程、单用户假设；不做多窗口并发写（`baseHash` 冲突会拒绝覆盖）。

## 文档

- 文档入口：[`docs/README.md`](docs/README.md)
- 功能规格：[`docs/01-功能规格.md`](docs/01-功能规格.md)
- 实现架构：[`docs/02-实现架构.md`](docs/02-实现架构.md)
- 整体架构图：[`docs/03-整体架构图.html`](docs/03-整体架构图.html) · [截图](docs/acceptance/架构图.png)
- 协作与测试（智能体上手、数据契约→测试矩阵、配置分层、定向测试纪律）：[`docs/05-协作与测试.md`](docs/05-协作与测试.md)
- 发布与更新：[`docs/04-发布与更新.md`](docs/04-发布与更新.md)
- 贡献规则：[`CONTRIBUTING.md`](CONTRIBUTING.md)

## License

[MIT](LICENSE)
