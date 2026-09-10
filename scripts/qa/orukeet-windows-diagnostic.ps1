# Fork-only qualification: never changes the application or inference sources.
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$evidence = Join-Path $repo 'windows-diagnostic'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$script:stages = [System.Collections.Generic.List[object]]::new()
$script:result = [ordered]@{
  started_utc = [DateTime]::UtcNow.ToString('o')
  os = [Environment]::OSVersion.VersionString
  tar_commands = @()
  stages = $script:stages
  selected_path_prefix = $null
  status = 'running'
}

function Get-ChildProcessTree([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootProcessId)
  do {
    $added = $false
    foreach ($item in $all) {
      if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) {
        $added = $true
      }
    }
  } while ($added)
  @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
}

function Invoke-Bounded {
  param(
    [string]$Label,
    [string]$Executable,
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 100,
    [string]$WorkingDirectory = $repo
  )
  $stdout = Join-Path $evidence "$Label.stdout.txt"
  $stderr = Join-Path $evidence "$Label.stderr.txt"
  $started = [DateTime]::UtcNow
  Write-Host "Starting $Label : $Executable $($Arguments -join ' ') (limit ${TimeoutSeconds}s)"
  $child = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $finished = $child.WaitForExit($TimeoutSeconds * 1000)
  $tree = @()
  if (-not $finished) {
    $tree = @(Get-ChildProcessTree $child.Id)
    $tree | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $evidence "$Label.processes.json")
    Write-Host "Timeout in $Label; descendant processes:"
    Write-Host ($tree | ConvertTo-Json -Depth 6)
    # Only the diagnostic command's process tree is terminated.
    & "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F | ForEach-Object { Write-Host $_ }
    [void]$child.WaitForExit(10000)
  } else {
    # Ensure redirected output is fully drained before reading it.
    $child.WaitForExit()
  }
  $stage = [ordered]@{
    label = $Label
    executable = $Executable
    arguments = $Arguments
    working_directory = $WorkingDirectory
    started_utc = $started.ToString('o')
    elapsed_seconds = ([DateTime]::UtcNow - $started).TotalSeconds
    timed_out = -not $finished
    exit_code = if ($finished) { $child.ExitCode } else { $null }
    processes_on_timeout = $tree
  }
  $script:stages.Add($stage)
  Write-Host ($stage | ConvertTo-Json -Depth 6)
  foreach ($log in @($stdout, $stderr)) {
    Write-Host "Last output from $([IO.Path]::GetFileName($log)):"
    if (Test-Path $log) { Get-Content $log -Tail 12 | ForEach-Object { Write-Host $_ } }
  }
  return $stage
}

try {
  Write-Host 'where.exe tar:'
  & "$env:SystemRoot\System32\where.exe" tar | ForEach-Object { Write-Host $_ }
  $commands = @(Get-Command tar -All | Select-Object Name, CommandType, Source, Definition)
  $script:result.tar_commands = $commands
  Write-Host ($commands | ConvertTo-Json -Depth 4)
  $systemTar = "$env:SystemRoot\System32\tar.exe"
  $gitTar = Join-Path $env:ProgramFiles 'Git\usr\bin\tar.exe'
  $candidates = @((Get-Command tar -CommandType Application).Source, $systemTar, $gitTar) | Select-Object -Unique
  $index = 0
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      [void](Invoke-Bounded -Label "tar-version-$index" -Executable $candidate -Arguments @('--version') -TimeoutSeconds 5)
      $index++
    }
  }
  $original = Invoke-Bounded -Label 'original-npm-download' -Executable $env:ComSpec -Arguments @('/d', '/c', '"npm run download:sherpa-onnx"')
  $installed = -not $original.timed_out -and $original.exit_code -eq 0
  if (-not $installed) {
    $archive = 'sherpa-onnx-v1.13.4-win-x64-shared-MD-Release.tar.bz2'
    $binDir = Join-Path $repo 'resources\bin'
    $archivePath = Join-Path $binDir $archive
    if (-not (Test-Path $archivePath)) { throw "Original runtime attempt left no archive at $archivePath" }
    $script:result.archive = [ordered]@{
      bytes = (Get-Item $archivePath).Length
      sha256 = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLower()
    }
    $originalPath = $env:PATH
    foreach ($choice in @(@{ name = 'system32'; executable = $systemTar }, @{ name = 'git'; executable = $gitTar })) {
      if (-not (Test-Path $choice.executable)) { continue }
      $extractDir = "diagnostic-extract-$($choice.name)"
      New-Item -ItemType Directory -Path (Join-Path $binDir $extractDir) -Force | Out-Null
      $direct = Invoke-Bounded -Label "direct-$($choice.name)-extract" -Executable $choice.executable -Arguments @('-xjf', $archive, '-C', $extractDir) -TimeoutSeconds 60 -WorkingDirectory $binDir
      if ($direct.timed_out -or $direct.exit_code -ne 0) { continue }
      # Select this already-installed tar for the unchanged production setup script.
      $prefix = Split-Path $choice.executable
      $env:PATH = "$prefix;$originalPath"
      $retry = Invoke-Bounded -Label "download-with-$($choice.name)" -Executable $env:ComSpec -Arguments @('/d', '/c', '"node scripts/download-sherpa-onnx.js --current"') -TimeoutSeconds 120
      if (-not $retry.timed_out -and $retry.exit_code -eq 0) {
        $installed = $true
        $script:result.selected_path_prefix = $prefix
        $prefix | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
        break
      }
    }
  }
  if (-not $installed) { throw 'Stock runtime did not install within bounded diagnostic attempts' }
  $marker = Join-Path $repo 'resources\bin\.sherpa-onnx-win32-x64.json'
  $script:result.install_marker = Get-Content -Raw $marker | ConvertFrom-Json
  $script:result.status = 'passed'
} catch {
  $script:result.status = 'failed'
  $script:result.error = $_.Exception.ToString()
  Write-Host $script:result.error
} finally {
  $script:result.finished_utc = [DateTime]::UtcNow.ToString('o')
  $script:result | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $evidence 'summary.json')
}
if ($script:result.status -ne 'passed') { exit 1 }
