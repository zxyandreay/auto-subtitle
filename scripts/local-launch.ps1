param(
  [string]$HostAddress = "127.0.0.1",
  [int]$Port = 5173,
  [string]$Url = "http://127.0.0.1:5173",
  [int]$WatchdogParentProcessId = 0,
  [int]$WatchdogRootProcessId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Stop-ProcessTree {
  param([int]$RootProcessId)

  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $RootProcessId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    Stop-ProcessTree -RootProcessId ([int]$child.ProcessId)
  }

  Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
}

if ($WatchdogParentProcessId -gt 0 -and $WatchdogRootProcessId -gt 0) {
  while (Get-Process -Id $WatchdogParentProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 500
  }

  Stop-ProcessTree -RootProcessId $WatchdogRootProcessId
  exit 0
}

function Quote-ProcessArgument {
  param([string]$Value)

  return '"' + ($Value -replace '"', '\"') + '"'
}

function Start-LauncherWatchdog {
  param([int]$RootProcessId)

  $powershellCommand = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
  $watchdogArguments = @(
    (Quote-ProcessArgument "-NoProfile")
    (Quote-ProcessArgument "-ExecutionPolicy")
    (Quote-ProcessArgument "Bypass")
    (Quote-ProcessArgument "-File")
    (Quote-ProcessArgument $PSCommandPath)
    (Quote-ProcessArgument "-WatchdogParentProcessId")
    (Quote-ProcessArgument ([string]$PID))
    (Quote-ProcessArgument "-WatchdogRootProcessId")
    (Quote-ProcessArgument ([string]$RootProcessId))
  ) -join " "

  Start-Process `
    -FilePath $powershellCommand `
    -ArgumentList $watchdogArguments `
    -WorkingDirectory $repositoryRoot `
    -WindowStyle Hidden | Out-Null
}

function Test-EnterPressed {
  if ([Console]::IsInputRedirected) {
    return $false
  }

  try {
    while ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      if ($key.Key -eq [ConsoleKey]::Enter) {
        return $true
      }
    }
  } catch {
    return $false
  }

  return $false
}

$server = $null
$exitCode = 0

try {
  $nodeCommand = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  $viteCli = Join-Path $repositoryRoot "node_modules\vite\bin\vite.js"
  if (-not (Test-Path -LiteralPath $viteCli)) {
    throw [IO.FileNotFoundException]::new("Vite CLI was not found. Run npm install, then launch again.", $viteCli)
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodeCommand
  $startInfo.Arguments = @(
    (Quote-ProcessArgument $viteCli)
    (Quote-ProcessArgument "--host")
    (Quote-ProcessArgument $HostAddress)
    (Quote-ProcessArgument "--port")
    (Quote-ProcessArgument ([string]$Port))
    (Quote-ProcessArgument "--strictPort")
  ) -join " "
  $startInfo.WorkingDirectory = $repositoryRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.CreateNoWindow = $false

  Write-Host "Starting Vite on $Url"
  $server = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $server) {
    throw [InvalidOperationException]::new("Unable to start Vite.")
  }

  $server.StandardInput.Close()
  Start-LauncherWatchdog -RootProcessId $server.Id

  Write-Host "Press ENTER to stop the local server and close this session."
  Write-Host ""

  while ($true) {
    if ($server.WaitForExit(250)) {
      $exitCode = $server.ExitCode
      break
    }

    if (Test-EnterPressed) {
      Write-Host ""
      Write-Host "Stopping local Auto Subtitle server..."
      $exitCode = 0
      break
    }
  }
} catch {
  Write-Host ""
  Write-Host "Launcher failed: $($_.Exception.Message)"
  $exitCode = 1
} finally {
  if ($null -ne $server -and -not $server.HasExited) {
    Stop-ProcessTree -RootProcessId $server.Id
    try {
      $server.WaitForExit(5000) | Out-Null
    } catch {
      # The process may already be gone after the process tree is stopped.
    }
  }
}

exit $exitCode
