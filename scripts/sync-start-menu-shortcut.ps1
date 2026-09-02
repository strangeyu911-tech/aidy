param(
  [string]$ArtifactPath = "",
  [string]$ShortcutPath = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $ArtifactPath) {
  $ArtifactPath = Join-Path $projectRoot "dist\win-unpacked\CyberBoss.exe"
}
if (-not $ShortcutPath) {
  $programs = [Environment]::GetFolderPath("Programs")
  $ShortcutPath = Join-Path $programs "CyberBoss.lnk"
}

if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) {
  throw "Verified development artifact does not exist: $ArtifactPath"
}

$workingDirectory = Split-Path -Parent $ArtifactPath
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $ArtifactPath
$shortcut.WorkingDirectory = $workingDirectory
$shortcut.Arguments = ""
$shortcut.Description = "CyberBoss"
$shortcut.IconLocation = "$ArtifactPath,0"
$shortcut.Save()

$verify = $shell.CreateShortcut($ShortcutPath)
if ($verify.TargetPath -ne $ArtifactPath) {
  throw "Start menu shortcut target verification failed: $($verify.TargetPath)"
}
if ($verify.WorkingDirectory -ne $workingDirectory) {
  throw "Start menu shortcut working directory verification failed: $($verify.WorkingDirectory)"
}

[pscustomobject]@{
  Path = $ShortcutPath
  Target = $verify.TargetPath
  StartIn = $verify.WorkingDirectory
  Arguments = $verify.Arguments
  Icon = $verify.IconLocation
} | Format-List
