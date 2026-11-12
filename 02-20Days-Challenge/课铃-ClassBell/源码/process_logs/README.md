# process_logs

本目录保存课铃的真实运行日志，按自然日一个 JSONL 文件。

## 当前文件

- `2026-11-09.jsonl`：首次真实运行会话（9 次启动、103 条事件）；
- `index.json`：最近 7 天聚合索引。

## 字段

| 字段 | 说明 |
| --- | --- |
| `v` | 日志 schema 版本 |
| `ts` | UTC ISO 时间 |
| `local` | 本机时间（已去除个人信息，仅用于阅读） |
| `tz` | 时区偏移（分钟） |
| `day` | 自然日 |
| `session` | 本次启动的随机 UUID |
| `seq` | 本次会话事件序号 |
| `app` | 版本 |
| `install` | 随机安装 ID，不是机器码 |
| `event` | 事件名 |
| `ok` | 是否成功 |
| `duration_ms` | 操作耗时 |
| `error` | `{code,message}`，不含账号/课程内容 |
| `meta` | 计数、来源、动作等非敏感元数据 |

## 事件

`app_start`、`app_stop`、`heartbeat`、`sync_start`、`sync_complete`、`sync_merge`、`sync_failed`、`task_added`、`task_completed`、`reminder_fired`、`reminder_action`、`reminder_done`、`reminder_snoozed`、`page_view`、`settings_updated`、`logs_exported` 等。

## 生成方式

由 `server/telemetry.js` 在真实运行时写入；设置页选择 Git 仓库根目录后自动镜像到 `<仓库>/process_logs/`。

## 诚信声明

- 不手工修改时间戳；
- 不补写未发生的日期；
- 不用脚本批量生成“历史日志”；
- 7 天日志由程序在 7 个自然日真实运行产生。

详见 `docs/7天运行计划.md`。
