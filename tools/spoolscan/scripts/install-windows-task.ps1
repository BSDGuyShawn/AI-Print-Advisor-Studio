# Registers spoolscan to start in the background at logon (no console window).
# Run from the spoolscan folder in a normal (non-admin) PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows-task.ps1
param(
  [string]$Out    = "$env:USERPROFILE\spoolscan\spools.jsonl",
  [string]$Latest = "$env:USERPROFILE\spoolscan\latest.json",
  [string]$Webhook = ""
)
$pyw = (Get-Command pythonw.exe -ErrorAction Stop).Source
$args = "-m spoolscan --log-file `"$env:USERPROFILE\spoolscan\spoolscan.log`" watch --quiet --out `"$Out`" --latest `"$Latest`""
if ($Webhook) { $args += " --webhook `"$Webhook`"" }
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\spoolscan" | Out-Null
$action   = New-ScheduledTaskAction -Execute $pyw -Argument $args
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "spoolscan" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "spoolscan"
Write-Host "spoolscan is running. Scans go to $Out"
Write-Host "Remove with: Unregister-ScheduledTask -TaskName spoolscan -Confirm:`$false"
