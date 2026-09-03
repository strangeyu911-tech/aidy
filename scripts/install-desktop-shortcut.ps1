$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$artifactPath = Join-Path $projectRoot "dist\win-unpacked\Aidy.exe"
if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
  throw "Aidy packaged executable does not exist: $artifactPath"
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutName = [string]::Concat([char]0x542F, [char]0x52A8, " 艾迪.lnk")
$shortcutPath = Join-Path $desktop $shortcutName
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $artifactPath
$shortcut.Arguments = ""
$shortcut.WorkingDirectory = Split-Path -Parent $artifactPath
$shortcut.Description = "Open Aidy desktop control center"
$shortcut.IconLocation = "$artifactPath,0"
$shortcut.Save()

$oldShortcutPath = Join-Path $desktop ([string]::Concat([char]0x542F, [char]0x52A8, " CyberBoss.lnk"))
if (Test-Path -LiteralPath $oldShortcutPath -PathType Leaf) {
  Remove-Item -LiteralPath $oldShortcutPath -Force
}

Write-Output $shortcutPath
