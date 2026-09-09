# 合规检查模块

以常驻 Python Sidecar 执行确定性规则检查，结果经 B 侧任务体系落 SQLite，并在“标书检查 → 合规检查”页面展示。

## 当前检查项

| check_id | 名称 | 是否依赖模型 |
| --- | --- | --- |
| `pricing_arithmetic` | 报价算术核查 | 否 |
| `validity` | 投标有效期核查 | 否 |
| `deposit` | 投标保证金核查 | 否 |
| `cross_check` | 评分项交叉对照 | 是（走本机模型代理） |

新增检查项需要同步登记三处：`checker/runner.py` 的 `CHECK_REGISTRY`、`complianceCheckRegistry.cjs`、`src/features/compliance-check/types.ts` 的 `ComplianceCheckId`。

## 协议 v1.0

Sidecar 从 stdin 逐行读 JSON，向 stdout 逐行写协议 JSON；stderr 只写日志，因此 `stdout` 可以直接机器解析。

请求：

```json
{
  "version": "1.0",
  "job_id": "job-001",
  "action": "run_checks",
  "model_config": {
    "base_url": "http://127.0.0.1:4891/v1",
    "model": "deepseek-chat"
  },
  "input": {
    "tender_file": "C:/workspace/招标文件.md",
    "bid_file": "C:/workspace/投标文件.md",
    "project_metadata": { "bid_deadline": "2026-03-15" },
    "checks": ["pricing_arithmetic", "validity", "deposit"]
  }
}
```

`action` 还支持 `ping`（健康检查并回报可用检查项）和 `shutdown`。

### 令牌如何到达 Sidecar

代理令牌不属于协议内容：`complianceModelProxy` 启动本机代理后，通过子进程环境变量 `YIBIAO_COMPLIANCE_MODEL_TOKEN` 传给 Sidecar，`llm_client.py` 读取后仅用于访问回环代理。
因此 `model_config`、stdin、stdout、日志与 SQLite 里都不会出现令牌或模型服务商密钥。缺令牌时 Sidecar 直接返回可读错误，而不是静默跳过。

需要模型的检查项若未拿到 `model_config`，返回 `CHECK_SKIPPED_MODEL_UNAVAILABLE` 提醒；单个检查项失败只影响自己，同批其他检查项结果保持完整。
### model_config 替代 api_key

`model_config` 是模型路由信息，只允许 `base_url`、`model`、`reasoning_effort` 三个字段：

- **协议不接受任何凭据字段**。`api_key`、`token`、`authorization` 等键名一旦出现，B 侧抛 `COMPLIANCE_MODEL_CONFIG_INVALID` / `COMPLIANCE_CREDENTIAL_FIELD_FORBIDDEN`，Sidecar 侧再用同样规则独立校验一次。
- `base_url` 只允许指向本机回环地址，也就是 B 暴露的本地模型代理，避免 Sidecar 绕过 `aiService` 的队列、重试与统计直连第三方。
- 错误信息不回显字段值，密钥不会进入 stdin、stdout、日志、SQLite。
- `project_metadata` 是自由结构，落库前会递归剔除凭据字段。
- 不依赖模型的检查项即使收到 `model_config` 也不会调用模型；需要模型但未收到 `model_config` 的检查项会返回 `CHECK_SKIPPED_MODEL_UNAVAILABLE` 提醒，而不是崩溃。

## 运行与打包

开发态优先使用打包产物，源码更新时自动回落解释器：

1. `client/vendor/compliance-checker/<platform>-<arch>/checker(.exe)`（由 `npm run prepare-compliance-checker` 生成，PyInstaller **onedir**）
2. 回落 `python checker_sidecar.py`（可用 `YIBIAO_PYTHON_PATH` 指定解释器）

```powershell
cd client
npm run prepare-compliance-checker   # 生成免 Python 依赖的本地运行时
npm run smoke:compliance-checker     # Electron 下验证 SQLite 迁移 + 真实 Sidecar + 凭据拦截
npm run smoke:compliance-ui           # 需先 npm run dev；离屏窗口驱动真实页面
```

`dist:win` / `dist:mac` 与 Release 工作流都会先生成 Sidecar 再打包。安装包内布局：

- `resources/compliance-checker/`：exe 及其依赖目录
- `resources/compliance-checker-src/`：Python 源码副本，供回落与排障

## 验收口径

- 一个检查失败不影响同批其他检查（`_error_result` 兜底）。
- 超时后任务失败但进程可重启，不卡死后续任务。
- 中文路径（含中文项目目录）必须可用。
- SQLite 文件内不得出现 `sk-` 前缀等凭据痕迹。
