# AGENTS · personal-task-workbench

> 项目级 Agent 配置。只放每次任务都要遵守的边界；细节看 `docs/README.md`。

## 项目

**任务管理**（项目目录/包名仍为 `personal-task-workbench` / `dsh-personal-task-workbench`）：DeepSeek Harness 插件 + 侧栏入口的轻量任务管理 + 想法池 + 复盘。当前阶段：**V3.0 已实现、已验收**；进入日常试用与小步修正。任务：登记 + 今日/本周查看 + 创建/编辑/删除/完成，分**当天 / 跨周期**，日期可带可选时间。想法池：捕获 + 四态 + 三档成熟度 + 多行详细描述。复盘：日 / 周 / 月，到点提示 + 人写 + 窗口内可改，AI 只读。

## 必读

- `docs/README.md`（当前状态、已定决策、安装方式、已知限制）
- `docs/01-功能规格.md`（做什么/不做什么、任务/想法/复盘字段、操作、验收）
- `docs/02-实现架构.md`（数据契约、代码结构、统一读写层、测试、安装）

## 硬边界

1. **只做任务管理 + 想法池 + 复盘**：任务做今日/本周/任务总表、查看、创建、编辑、删除、完成/撤销、当天与跨周期（连续开始→结束区间）、可选 `HH:mm`；想法做列表/筛选/搜索、新建、编辑内容、改状态、删除、四态（待实现/推进中/完成/放弃）、三档成熟度、多行描述；复盘做日/周/月三类、窗口内提交/编辑/清空、周/月内联材料、AI 只读。不扫描知识库、不生成 Daily、不做固定动作/项目方向/周期任务（重复规则）/农历/提醒推送/迁移导入；**不做想法→任务转化、想法看板、自动归档**；**不做复盘历史 tab、复盘统计、AI 写复盘、补写更早周期**。
2. **数据真源 = 工作台自有数据目录**（默认 `$DSH_HOME/personal-task-workbench/data`，可由 `settings.json` 的 `dataRoot` 覆盖；本地开发可指向仓库内 `data/`，已 gitignore）：任务 `data/任务清单/YYYY-MM.md` 按月分片；想法 `data/想法池/想法池.md` 单文件不按月切；复盘 `data/复盘/日复盘.md`、`周复盘.md`、`月复盘.md` 三个单文件不按月切。数据根与安装形态解耦：换机、升级插件都不写进 `node_modules` 副本。不读写、不依赖任何外部笔记/Daily 系统。
3. **AI 权限边界**：AI 走统一层——任务 `TaskService`（`ptw_*`）、想法 `IdeaService`（`ptw_idea_*`）、复盘 `ReviewService`（`ptw_review_list` / `ptw_review_get` 只读），写入均带 actor 审计；**任务完成/撤销完成仅人**，**想法状态流转仅人**，**复盘正文仅人写**（没有对应写工具，越权返回 `permission-denied`）；失败不假装成功。随包技能 `personal-task-workbench` 只是工具使用说明，不是第二条写路径。
4. **文档极简**：`docs/` 只保留 README + 01 功能规格 + 02 实现架构 + 03 架构图 + `acceptance/` 架构图；过期文档直接删除，不再恢复编号堆叠。
5. **客户端形态**：原生 React（`lib/client.js` 手写 lazy-CJS，无构建步骤），不用 iframe；不 import 任何 `@deepseek-ai/dsh-client-*` 包；样式只用 `--dsw-alias-*` / `--dsw-elevation-*` token。
6. **Host 写文件用 `node:fs`**（持久插件在 Host 进程内），不用 `ctx.fs`；唯一写网关是 `TaskService` / `IdeaService` / `ReviewService`（三个域各一个，共用 `WriteGateway` 的队列/幂等/审计），UI 与 AI 都不许另开写路径。
7. **测试纪律**：自动化测试只用 `os.tmpdir()` 临时数据根，**绝不碰真实 `data/`**；真实环境验收前先备份任务分片、想法文件、复盘文件与插件状态，验收后还原并清理测试任务/想法/复盘/备份。
8. **Git 节奏**：提交前跑 `node --test tests/*.test.mjs`；代码/文档改动**默认由 AI 本地提交（commit）**，**不要执行 `git push`**；推送/发布/npm publish/市场投稿由仓库所有者显式授权后执行。

## 工作方式

- **Git**：有改动默认 `git commit` 到本地本仓；**不执行 `git push`**（推送由仓库所有者统一做）。提交信息写清改了什么。
- 任务/想法/复盘数据放数据根（默认 `$DSH_HOME/personal-task-workbench/data`，已 gitignore），不要提交进 Git；插件状态在 `$DSH_HOME/personal-task-workbench/`。
- 改 host 代码后：插件页把组件关/开一次触发重载，或重启 App；改 client 代码后刷新页面（DSH HMR）。
- 页面细节继续打磨，但先保证「读对、写对、数据不丢」；不伪造证据，不把「文档写完」当「已验证」。
- 新增能力/字段/视图前先确认在 V3.0 边界内（任务：当天/跨周期/可选时间/今日/本周/总表；想法：四态/成熟度/描述/列表；复盘：日/周/月 + 可写窗口 + 材料 + AI 只读）；超出边界另开版本，不往里塞。
- 复盘可写窗口是口径核心：日=今天、周=本周（复盘上一自然周）、月=月末最后一天→次月 3 日；改窗口必须同时改 `core/review-window.js` 与文档，并补窗口单测。
