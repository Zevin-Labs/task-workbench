# 任务工作台 + 想法池 + 复盘

> DeepSeek Harness 本机插件：管理任务、想法池与日/周/月复盘。任务统一为连续时间区间（开始/截止日期 + 整点，未填按默认值派生）。想法支持四种状态、三档成熟度和多行描述。复盘由人写，AI 只读。
> 数据统一保存在本机 SQLite 数据库。已发布的 npm 0.5.0 使用 Markdown，是历史版本；当前代码不读取或导入旧版 Markdown。

[English README](README.md)

## 当前状态

当前已发布版本为 [npm 0.6.1](https://www.npmjs.com/package/dsh-task-workbench/v/0.6.1) / [GitHub Release v0.6.1](https://github.com/Zevin-Labs/task-workbench/releases/tag/v0.6.1)，发布于 2026-11-08。V3.0 的功能口径保持不变；使用 Node 内置 node:sqlite，数据库文件为数据根下的 workbench.sqlite。0.5.0 保留为历史 Markdown 版本。SQLite 版本初始化为空库，不导入旧数据。旧版测试数据已私下归档，不记录本机路径。

要求 Node >=24；DSH 版本范围见 package.json。插件无构建步骤和运行时第三方依赖。

## 安装

从 npm 安装：

    dsh plugin --profile <profile> add dsh-task-workbench

从 GitHub 安装：

    dsh plugin --profile <profile> add github:Zevin-Labs/task-workbench

安装后打开侧栏「任务工作台」。首次使用时在页面内初始化空数据库。

## 使用

1. **今日**：查看逾期、今天要做的任务和今天已完成任务；底部是日/周/月复盘区。
2. **本周**：周一到周日 7 个日卡；跨周期任务按轨道贯穿整周（每条一个颜色，线从开始日连到截止卡，卡落在截止日），格子里先排跨周期截止卡再排当天任务；当天任务用底色表示四象限优先级。底部有本周/本月概览（完成率环）和可翻月的月历，点日期查看当天任务并可进入编辑或当天新建。
3. **任务**：查看全部未完成任务及本月已完成任务，可按关键词、状态和优先级筛选。
4. **想法**：按状态统计和筛选，搜索名称/描述，按成熟度或分类筛选；人可以改状态。
5. **复盘**：窗口内提交、编辑、清空；复盘区提供周期回查入口，历史内容只读。
6. **AI**：共 14 个工具，任务 7 个、想法 5 个、复盘只读 2 个。AI 可管理任务内容和想法内容；任务完成/撤销、想法状态与复盘正文只能由人操作。

日期规则保持稳定：日复盘写今天；周复盘在周一至周日写上一个自然周；月复盘在月末最后一天至次月 3 日写本月。

## 数据与隐私

- 数据库位于数据根下的 workbench.sqlite；默认数据根为 DSH_HOME/task-workbench/data，可由 settings.json 的 dataRoot 覆盖。
- 数据库包含 tasks、ideas、reviews、write_log 和内部 meta 表。settings.json 只保存 dataRoot 与 backupRetentionDays；初始化状态由数据库判断。
- 所有界面与 AI 工具经各自领域 Service 读写同一个数据库。SQLite 短事务一起提交业务变更、写入审计和版本号；请求携带 baseVersion 时可拒绝陈旧更新。
- 跨月任务仍是同一条数据库记录；过月已完成任务只读。
- 删除任务、删除想法、清空复盘前生成并校验 SQLite 快照。备份默认保留 7 天，backupRetentionDays 可设 1–90。
- 不扫描知识库、Daily 或外部笔记，不访问外网，不导入旧版 Markdown。升级插件不影响独立数据根；换机时备份并复制数据库。
- 任务 ID 与想法 ID 是稳定序号（T-1、I-1）。未来时间块规划和人与 AI 协作任务当前未实现，不预建未来字段或工具。

## 开发

    npm run check
    npm run test:task
    npm run test:idea
    npm run test:review
    npm run test:cross

测试只使用 os.tmpdir() 临时数据根，不触碰真实数据。按 docs/05 的矩阵运行受影响域测试；全量测试用于发版、跨域共享改动和 CI。

修改 Client 后刷新页面即可；修改 Host 后要重启 DSH（插件重载不会重新加载 host 模块）。开发数据请使用独立临时 dataRoot，不要将真实数据根用于测试。

## 功能边界

**包含**：今日/本周/任务列表；连续时间区间（开始/截止日期 + 整点，未填按默认值派生）；任务查看、创建、编辑、删除、完成/撤销；本周页的跨周期轨道与截止卡、本周/本月概览与只读月历（可翻月、点日期查看当天任务）；想法列表、搜索、筛选与状态管理；日/周/月复盘；周/月复盘材料与历史只读回查。

**不包含**：任务月份历史浏览、旧版 Markdown 导入、重复任务、提醒推送、想法转任务、看板、自动归档、复盘统计、更早周期补写、时间块匹配、AI 认领/执行/审核。

## 文档

- [文档索引](docs/README.md)
- [功能规格](docs/01-功能规格.md)
- [实现架构](docs/02-实现架构.md)
- [整体架构图](docs/03-整体架构图.html)
- [协作与测试](docs/05-协作与测试.md)
- [发布与更新](docs/04-发布与更新.md)
- [贡献规则](CONTRIBUTING.md)

## License

[MIT](LICENSE)
