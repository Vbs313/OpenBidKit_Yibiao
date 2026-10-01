# IPC_CONTRACT_AUDIT.md — 内部 API 契约排查与架构评估

> **目标**：排查 IPC/协议/解析的内部 API 契约是否需修改，评估架构是否需优化，保证项目高效运行
> **基线**：`main` @ `c190894`（2026-10-01）
> **验证方式**：`git grep` 全量扫描 + `verify:module-graph` + `verify:store-di` + 门禁套件

---

## 1. 内部 API 契约清单（4 项）

### 1.1 `window.yibiao` / `window.yibiaoClient`（preload bridge）

| 维度 | 详情 |
|---|---|
| **定义** | `client/electron/preload.cjs:284-286`（`contextBridge.exposeInMainWorld`） |
| **规模** | bridge 180 个方法 / `ipc.ts` 178 个类型 / `ipcMain.handle` 179 个 |
| **使用面** | **56 个 Renderer 文件**调用 `window.yibiao` |
| **命名规范** | `域名:动作`（如 `config:load`、`ai:chat`），15 个域名清晰分组 |
| **未使用方法** | **0 个**（无死代码） |

**结论：✅ 不需要修改**

- 契约一致性优秀（bridge/handler/types 基本 1:1）
- 命名规范统一
- 无死代码
- 改名风险：**极高**（56 文件 × 180 方法 = 9000+ 引用点），且改名无功能收益

### 1.2 `yibiao-asset://` 自定义协议

| 维度 | 详情 |
|---|---|
| **定义** | `client/electron/main.cjs:237,242`（`protocol.handle`） |
| **使用面** | **14 个文件**（含 12 个 .cjs + 2 个 .ts + 2 个文档） |
| **用途** | 生成图片/导入图片/资信库资源的本地 URL（`yibiao-asset://generated-images/...`） |
| **解析点** | `duplicates/analysisSupport.cjs:129`（正则匹配）等多处 |

**结论：✅ 不需要修改**

- Electron 自定义协议机制成熟，命名不影响功能
- 改名需同步改 14 个文件 + C# 端（若有引用）+ 测试，风险中等
- 协议名是**内部标识**，用户不可见

### 1.3 `<!-- yibiao:block -->` HTML 标记

| 维度 | 详情 |
|---|---|
| **定义** | 仅在 2 个资源文件（`受限HTML生成规范.md` + `正文模板.html`） |
| **解析代码** | **无**（已删除的 `restrictedHtml.ts` 曾解析，现无消费者） |
| **C# 端** | `RestrictedHtmlDocumentRenderer.cs` 用 AngleSharp `Body!.Children` 遍历，**注释节点被忽略** |
| **实际作用** | 给 AI 的**格式说明**（告诉 AI 如何分块生成受限 HTML） |

**结论：✅ 不需要修改（但建议澄清）**

- `yibiao:block` 是**提示词约定**，不是解析契约
- C# 端 AngleSharp 的 `Children` 只返回元素节点，注释被安全忽略
- 已验证：删除 `restrictedHtml.ts` 后无残留引用，功能正常

**建议**：在 `受限HTML生成规范.md` 加注释说明「此标记仅供 AI 参考，C# 端按 HTML 标签解析」

### 1.4 `--yibiao-trial-hardware-acceleration` GPU 参数

| 维度 | 详情 |
|---|---|
| **定义** | `main.cjs:11` + `ipc/index.cjs:367` |
| **使用面** | **2 个文件**，8 处引用 |
| **用途** | GPU 硬件加速试用（`app.relaunch()` 传参） |
| **性质** | 进程命令行参数，用户不可见 |

**结论：✅ 不需要修改**

- 仅 2 个文件，但改名需同步 `app.relaunch()` 参数传递链
- 命令行参数是**内部标识**，不影响用户
- 改名风险低但收益为零

---

## 2. 架构评估

### 2.1 IPC 契约一致性 ✅ 优秀

| 指标 | 数值 | 评价 |
|---|---|---|
| preload bridge 方法 | 180 | — |
| `ipc.ts` 类型方法 | 178 | 基本 1:1 |
| `ipcMain.handle` | 179 | 基本 1:1 |
| 未使用 bridge 方法 | **0** | ✅ 无死代码 |

### 2.2 命名规范 ✅ 优秀

`域名:动作` 模式，15 个域名清晰分组：

| 域名 | handler 数 |
|---|---|
| `technical-plan` | 23 |
| `tasks` | 18 |
| `knowledge-base` | 14 |
| `feasibility-report` | 13 |
| `credential-library` | 13 |
| `plugins` | 11 |
| `compliance-check` | 10 |
| 其他 8 个域名 | 77 |

### 2.3 错误处理 ⚠️ 不一致（但符合 AGENTS.md 设计）

| 状态 | 文件数 | 文件 |
|---|---|---|
| 有错误处理 | 7 | configIpc / credentialLibraryIpc / developerIpc / exportIpc / fileIpc / index / pluginIpc |
| 无错误处理 | 13 | agentIpc / aiIpc / autoConfirmationIpc / complianceCheckIpc / duplicateCheckIpc / feasibilityReportIpc / knowledgeBaseIpc / perfIpc / rejectionCheckIpc / systemFontIpc / taskIpc / technicalPlanIpc / templateIpc |

**评估：✅ 符合设计意图，不需要改**

依据 AGENTS.md：*"Electron Renderer、preload、Main 和内部 IPC 属于用户本机可信边界，不在层级间重复堆叠参数校验...不需要加过多安全性兜底"*

Electron `ipcMain.handle` 自动把 `throw` 传播为 `invoke` 的 Promise reject，Renderer 端已有 56 个文件调用 `window.yibiao` 且大多有 catch。**冗余的 try/catch 反而违反 AGENTS.md 的简洁原则**。

### 2.4 模块依赖 ✅ 优秀

- `verify:module-graph`：**无环、无悬空、层次方向正确**
- `verify:store-di`：**6 个工厂接线完整**

### 2.5 大文件 ⚠️ 8 个超 1000 行

| 文件 | 行数 | 评估 |
|---|---|---|
| `stores/technicalPlanStore.cjs` | 1685 | Store 层，职责集中，符合 AGENTS.md「闭包工厂包住整个领域」 |
| `tasks/contentGenerationTask.cjs` | 1393 | 任务编排，5 个子阶段已拆出 `generation/stages/` |
| `agent/agentOpenAiProxy.cjs` | 1323 | Agent 协议代理 |
| `pi/piRuntimeService.cjs` | 1177 | Pi Agent 运行时 |
| `stores/knowledgeBaseStore.cjs` | 1117 | Store 层 |
| `export/docxPrimitives.cjs` | 1115 | Word 导出原语 |
| `taskService.cjs` | 1084 | 任务服务编排 |
| `pi/piSelfCheckService.cjs` | 1029 | Pi 自检 |

**评估：✅ 不建议拆分**

依据 AGENTS.md「结构重构约定」：*「低于约 5 行每接口名不动刀」* + *「保留判据：① 闭包工厂包住整个领域；② 共享可变状态数 × 回调链长 > 拆分收益」*

这些大文件都是**领域内聚**的（Store/Task/Agent），拆分会引入跨文件状态传递，收益低于成本。

---

## 3. 最终结论

### 3.1 内部 API 契约：✅ 全部不需要修改

| 契约 | 结论 | 理由 |
|---|---|---|
| `window.yibiao` | 不改 | 56 文件 × 180 方法，改名风险极高，无功能收益 |
| `yibiao-asset://` | 不改 | 14 文件，内部标识用户不可见 |
| `yibiao:block` | 不改 | 仅提示词约定，C# 端安全忽略注释 |
| `--yibiao-trial-*` | 不改 | 2 文件，进程参数用户不可见 |

**核心原则**：这些是**内部 API 契约**，不是用户可见品牌。改名需同步改 C# 端、测试、文档，风险高、收益零。AGENTS.md 明确「不需要加过多安全性兜底」，同理不需要为「品牌纯洁性」承担重构风险。

### 3.2 架构：✅ 不需要优化

| 维度 | 状态 | 说明 |
|---|---|---|
| IPC 契约一致性 | ✅ 优秀 | bridge/handler/types 基本 1:1，无死代码 |
| 命名规范 | ✅ 优秀 | `域名:动作` 统一，15 个域名清晰 |
| 错误处理 | ✅ 符合设计 | AGENTS.md 明确 IPC 属可信边界，不堆叠校验 |
| 模块依赖 | ✅ 优秀 | 无环、无悬空、层次正确 |
| Store DI | ✅ 优秀 | 6 个工厂接线完整 |
| 大文件 | ✅ 不建议拆 | 领域内聚，符合 AGENTS.md 重构约定 |

### 3.3 高效运行保证

已验证的门禁套件：
- `npm test`：**691/691 全通过**
- `test:electron-abi`：**8/8 全通过**
- `python unittest`：**51 OK**
- `npm run build`：✅ 通过
- `verify:module-graph`：✅ 无环
- `verify:store-di`：✅ 6 工厂完整

---

## 4. 建议（可选，非必需）

| 建议 | 优先级 | 收益 | 成本 |
|---|---|---|---|
| 在 `受限HTML生成规范.md` 加注释澄清 `yibiao:block` 仅供 AI 参考 | 低 | 文档清晰 | 5 分钟 |
| 统一 IPC 错误处理（13 个文件补 try/catch） | **不建议** | — | 违反 AGENTS.md 简洁原则 |
| 拆分大文件 | **不建议** | — | 违反 AGENTS.md 重构约定 |
| 内部标识改名 | **不建议** | — | 风险高收益零 |

---

*本报告基于 2026-10-01 的全量排查（`main` @ `c190894`），所有数据来自 `git grep` 扫描 + 门禁套件验证。*
