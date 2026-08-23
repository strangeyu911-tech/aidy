$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$entryScript = Join-Path $projectRoot "src\desktop\main.js"
if (-not (Test-Path -LiteralPath $electronPath)) {
  throw "Electron desktop runtime is not installed: $electronPath"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutName = [string]::Concat([char]0x542F, [char]0x52A8, " CyberBoss.lnk")
$shortcutPath = Join-Path $desktop $shortcutName
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronPath
$shortcut.Arguments = '"' + $entryScript + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = "Open CyberBoss desktop control center"
$shortcut.IconLocation = "$electronPath,0"
$shortcut.Save()

Write-Output $shortcutPath
