# v0.1.2 真机验收脚本
# 1) 便携版：解压到带空格路径 → 启动 → 应用+sidecar 存活 + sidecar 实际处理文件（_open-counts.json 出现）
# 2) 安装版：静默安装 → 启动 → 同样验证 → 静默卸载

$ErrorActionPreference = 'Continue'
$csv = 'G:\csv-grid-editor-master\csv-grid-editor-master\samples\acceptance-40k.csv'
$zip = "$env:TEMP\csv-grid-editor-plus-portable.zip"
$setup = "$env:TEMP\CSV.Grid.Editor.Plus_0.1.2_x64-setup.exe"
$appdata = "$env:APPDATA\csv-grid-editor-plus"
$results = @{}

function Stop-All {
    Get-Process csv-grid-editor-plus -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-15) } | Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

# ── 便携版 ──
Stop-All
$portableDir = 'C:\Users\19055\AppData\Local\Temp\CSV Portable Test'
if (Test-Path $portableDir) { Remove-Item $portableDir -Recurse -Force }
Expand-Archive $zip -DestinationPath $portableDir
if (Test-Path "$appdata\byte-offset-index\_open-counts.json") { Remove-Item "$appdata\byte-offset-index\_open-counts.json" -Force }
$exe = Get-ChildItem $portableDir -Filter *.exe | Select-Object -First 1
Start-Process $exe.FullName -ArgumentList "`"$csv`""
Start-Sleep -Seconds 12
$app = (Get-Process csv-grid-editor-plus -ErrorAction SilentlyContinue | Measure-Object).Count
$node = (Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddSeconds(-30) } | Measure-Object).Count
$counts = Test-Path "$appdata\byte-offset-index\_open-counts.json"
$results['portable_app_alive']   = $app -ge 1
$results['portable_sidecar_up']  = $node -ge 1
$results['portable_engine_ran']  = $counts   # DocumentSession.open() 跑通的铁证

# ── 安装版 ──
Stop-All
& $setup /S
Start-Sleep -Seconds 15
$installed = "C:\Users\19055\AppData\Local\CSV Grid Editor Plus\csv-grid-editor-plus.exe"
$results['installer_laid_files'] = (Test-Path $installed) -and (Test-Path "C:\Users\19055\AppData\Local\CSV Grid Editor Plus\_up_\sidecar\node.exe")
if (Test-Path "$appdata\byte-offset-index\_open-counts.json") { Remove-Item "$appdata\byte-offset-index\_open-counts.json" -Force }
Start-Process $installed -ArgumentList "`"$csv`""
Start-Sleep -Seconds 12
$app2 = (Get-Process csv-grid-editor-plus -ErrorAction SilentlyContinue | Measure-Object).Count
$node2 = (Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddSeconds(-30) } | Measure-Object).Count
$counts2 = Test-Path "$appdata\byte-offset-index\_open-counts.json"
$results['installed_app_alive']  = $app2 -ge 1
$results['installed_sidecar_up'] = $node2 -ge 1
$results['installed_engine_ran'] = $counts2

Stop-All
& "C:\Users\19055\AppData\Local\CSV Grid Editor Plus\uninstall.exe" /S 2>$null
Start-Sleep -Seconds 5
$results['uninstall_clean'] = -not (Test-Path $installed)

Remove-Item $portableDir -Recurse -Force -ErrorAction SilentlyContinue
$results.GetEnumerator() | Sort-Object Name | Format-Table -AutoSize
