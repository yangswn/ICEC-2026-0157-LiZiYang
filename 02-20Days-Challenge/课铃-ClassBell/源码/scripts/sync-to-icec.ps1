<#
.SYNOPSIS
  把课铃主仓库（campus-pulse）单向镜像到作业仓库的 源码/ 目录。

.DESCRIPTION
  规则：代码只在 campus-pulse 改，作业仓库只接收镜像，绝不反向修改。
  这样两份内容不会分叉，出现差异时永远以 campus-pulse 为准。

  用法（在本目录执行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-to-icec.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-to-icec.ps1

  -DryRun 只列出“会复制/会删除”的内容，不动文件；确认后再真跑。
  镜像用 robocopy /MIR，目标里多出来的文件会被删除，保证两边完全一致。
#>
param(
  [string]$Source = "C:\Users\24373\Documents\deepseek-harness\default-workspace\campus-pulse",
  [string]$Target = "C:\Users\24373\Desktop\ICEC-2026-0157-LiZiYang\02-20Days-Challenge\课铃-ClassBell\源码",
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Source)) { throw "主仓库不存在: $Source" }
if (-not (Test-Path $Target)) { throw "目标目录不存在: $Target  (请先在作业仓库建好 源码/ 目录)" }

Write-Host "主仓库: $Source"
Write-Host "目标  : $Target"
if ($DryRun) { Write-Host "模式  : 试运行, 不修改任何文件" -ForegroundColor Yellow }
Write-Host ""

# 本机生成物 / 本地数据，不进作业仓库
$excludeDirs = @(
  '.git',
  'node_modules',
  'dist',
  'data',
  'installer\build',
  '.research',
  '.test-data',
  '.preview',
  '.cache',
  '.npm-cache',
  '.dsh-vision-router'
)

$excludeFiles = @('ClassBell.exe', 'CampusPulse.exe', '*.log', '*.tmp')

$rcArgs = @(
  $Source,
  $Target,
  '/MIR',
  '/R:2', '/W:1',
  '/NP',
  '/XD'
) + $excludeDirs + @('/XF') + $excludeFiles

if ($DryRun) {
  # 试运行：保留文件清单与汇总，方便核对会改什么
  $rcArgs += '/L'
} else {
  # 正式同步：只输出汇总，避免刷屏
  $rcArgs += @('/NFL', '/NDL', '/NJH', '/NJS')
}

Write-Host "开始镜像..." -ForegroundColor Cyan
$output = & robocopy @rcArgs
$code = $LASTEXITCODE

# robocopy 退出码是位标志, >= 8 才算失败
if ($code -ge 8) {
  Write-Host ""
  Write-Host "同步失败 (robocopy exit $code)" -ForegroundColor Red
  $output | Select-Object -Last 25
  exit 1
}

$output | Select-Object -Last 12

Write-Host ""
if ($DryRun) {
  Write-Host "试运行结束: 上面是"如果真跑会复制/删除"的内容。" -ForegroundColor Yellow
  Write-Host "确认无误后去掉 -DryRun 再跑一次。"
} else {
  Write-Host "同步完成: 作业仓库的 源码/ 已与 campus-pulse 一致。" -ForegroundColor Green
  Write-Host ""
  Write-Host "下一步 (在作业仓库里提交):"
  Write-Host '  cd "C:\Users\24373\Desktop\ICEC-2026-0157-LiZiYang"'
  Write-Host '  git add "02-20Days-Challenge/课铃-ClassBell/源码"'
  Write-Host '  git commit -m "chore(source): 同步课铃源码"'
}
