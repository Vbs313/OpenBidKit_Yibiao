# 合规检查 Sidecar

第一版只实现确定性检查：`pricing_arithmetic`（报价算术核查）。

## 协议 v1.0

Sidecar 从 stdin 逐行读取 JSON，向 stdout 逐行输出 JSON；stderr 只写日志。

请求：

```json
{
  "version": "1.0",
  "job_id": "job-001",
  "action": "run_checks",
  "input": {
    "tender_file": "C:/workspace/tender.md",
    "bid_file": "C:/workspace/bid.md",
    "project_metadata": {
      "total_amount": "5800000.00",
      "bid_amount": "5800000.00",
      "bid_amount_cn": "伍佰捌拾万元整"
    },
    "checks": ["pricing_arithmetic"]
  }
}
```

响应：

```json
{
  "version": "1.0",
  "job_id": "job-001",
  "status": "success",
  "results": []
}
```

`ping` 用于健康检查：

```json
{"version":"1.0","job_id":"ping-1","action":"ping"}
```

## 开发态运行

要求系统 PATH 中存在 `python`，或通过 `YIBIAO_PYTHON_PATH` 指定 Python 可执行文件。

```powershell
cd client/electron/services/compliance/checker
python -m unittest discover -s tests -v
python checker_sidecar.py
```

## 打包态说明

当前 `client/package.json` 会把 `checker/` 复制到安装包的 `resources/compliance-checker/`。  
如果打包机没有 Python 运行时，需要后续把 Sidecar 用 PyInstaller 打成 `checker.exe`，再让 `getBundledComplianceCheckerPath()` 命中该文件。第一版先验证协议、进程管理、SQLite 和 UI 闭环。
