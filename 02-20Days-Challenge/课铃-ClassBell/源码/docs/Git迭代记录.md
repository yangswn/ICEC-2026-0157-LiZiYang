# Git 迭代记录

日期：2026-11-09  
仓库：`campus-pulse/`（本地 Git，可推送 GitHub）

> 历史提交信息中的 `CampusPulse` 是开发期代号；1.0.0 对外名称已统一为 **课铃 ClassBell**，功能与数据路径以当前代码为准。

> **本文只覆盖 11-09 的第一批提交**（1.0.0 阶段）。
> 1.0.0 之后累计到 **45 次有实质改动的提交**（截至 2026-11-22 / v1.11.6），
> 逐条明细与每条改动的原因见作业仓库里的 `02-20Days-Challenge/课铃-ClassBell/README.md`
> 的「四十二次迭代」表；提交本身用 `git log --oneline` 核对。

## 提交 1 — 核心程序与日志驱动修复

`cfee329 feat: CampusPulse WebView2 desktop app, Chaoxing sync, reminders, telemetry`

包含：

- WebView2 主窗口、学习通独立登录窗口、提醒窗口、托盘、安装器；
- Node 本地服务、任务存储、同步、提醒调度、JSONL 遥测；
- 根据 2026-11-09 真实运行发现的问题同步修复：
  - 提醒窗口使用独立 WebView2 数据目录导致空白 → 共享主环境；
  - `late_min` 被误判为截止已过 → 按 `dueAt` 重新计算；
  - 逾期标签重复时间 → 相对天数 + 截止时间副标题；
  - 正常退出缺少 `app_stop` → 优雅退出；
  - 受限账户 AppData 写入失败 → 安装目录 `data\` 回退。

## 提交 2 — 文档与过程说明

`6df976c docs: add user manual, privacy notes, 7-day log plan, test and submission mapping`

包含：

- README、使用手册、隐私与合规、测试记录；
- 7 天日志计划、项目四提交映射；
- 9 张真实运行截图。

## 提交 3 — 真实运行数据

`a9bb36c chore(logs): add real day-1 telemetry session and 7-day index`

包含：

- `process_logs/2026-11-09.jsonl`：103 条真实事件、9 次启动；
- `process_logs/index.json`：最近 7 天聚合；
- `process_logs/README.md`：字段与诚信声明。

## 验证方式

```powershell
git log --oneline
git show --stat cfee329
git show --stat 6df976c
git show --stat a9bb36c
```

## 关于 7 天连续性

当时的记录：Git 中的真实日志只覆盖 2026-11-09（第 1 天）。

**实际结果**：从 11-09 到 11-22，连续 **14 天**每天都有真实日志，一天没断，已远超 7 天门槛。
日志由程序在真实使用中自然产生，没有补写、没有改时间戳。
每天的 JSONL 与 `index.json` 都在作业仓库的 `02-20Days-Challenge/process_logs/` 下，可逐行核对。
