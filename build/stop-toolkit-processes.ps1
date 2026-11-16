param(
    [string]$InstallDir,
    [string]$PreviousUserDir,
    [string]$PreviousMachineDir,
    [string]$LogPath = "$env:TEMP\toolkit-install-processes.log",
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'

function Get-ToolkitRoots([string[]]$Candidates) {
    $roots = @()
    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        # Accept only an existing toolbox installation, never a generic parent folder.
        if (Test-Path -LiteralPath (Join-Path $full '钊叔工具箱.exe') -PathType Leaf) {
            $roots += $full + '\'
        }
    }
    return @($roots | Select-Object -Unique)
}

function Test-ToolkitPath($Process, [string[]]$Roots) {
    if (-not $Process.ExecutablePath) { return $false }
    foreach ($root in $Roots) {
        if ($Process.ExecutablePath.Equals(($root + '钊叔工具箱.exe'), [StringComparison]::OrdinalIgnoreCase) -or
            $Process.ExecutablePath.StartsWith(($root + 'resources\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Get-ToolkitTargets([object[]]$Processes, [string[]]$Roots, [int[]]$ProtectedIds) {
    $selected = @{}
    foreach ($process in $Processes) {
        if ($ProtectedIds -contains [int]$process.ProcessId) { continue }
        if ($process.Name -match '^(Uninstall|setup|installer)' -or $process.Name -match '-win-(x64|arm64)\.exe$') { continue }
        if (Test-ToolkitPath $process $Roots) { $selected[[int]$process.ProcessId] = $process }
    }
    # Capture descendants before asking the main window to close, including browser processes outside the install folder.
    do {
        $added = $false
        foreach ($process in $Processes) {
            $id = [int]$process.ProcessId
            if ($ProtectedIds -contains $id -or $selected.ContainsKey($id)) { continue }
            if ($process.Name -match '^(Uninstall|setup|installer)' -or $process.Name -match '-win-(x64|arm64)\.exe$') { continue }
            $parent = $selected[[int]$process.ParentProcessId]
            if ($parent -and $process.CreationDate -and $parent.CreationDate -and $process.CreationDate -ge $parent.CreationDate) {
                $selected[$id] = $process
                $added = $true
            }
        }
    } while ($added)
    return @($selected.Values)
}

function Test-SameProcess($Original, $Current) {
    return $Current -and $Original.CreationDate -and $Current.CreationDate -and
        $Original.CreationDate -eq $Current.CreationDate -and
        $Original.ExecutablePath -eq $Current.ExecutablePath
}

function Write-InstallLog([string]$Message) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    Write-Output $line
}

function Stop-ToolkitProcesses {
    $roots = @(Get-ToolkitRoots @($InstallDir, $PreviousUserDir, $PreviousMachineDir))
    Write-InstallLog '开始检查工具箱相关进程。'
    if ($roots.Count -eq 0) { Write-InstallLog '未发现旧工具箱安装目录。'; return }
    $all = @(Get-CimInstance Win32_Process)
    if (@($all | Where-Object { $_.Name -eq '钊叔工具箱.exe' -and -not $_.ExecutablePath }).Count -gt 0) { throw '无法读取工具箱进程路径，请以管理员身份重试安装。' }
    $protected = @([int]$PID)
    $ancestor = $all | Where-Object { $_.ProcessId -eq $PID } | Select-Object -First 1
    $seen = @{}
    while ($ancestor -and $ancestor.ParentProcessId -and -not $seen.ContainsKey([int]$ancestor.ParentProcessId)) {
        $id = [int]$ancestor.ParentProcessId
        $seen[$id] = $true
        $ancestor = $all | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
        # Protect this installer and its helper, but allow a hung old toolbox ancestor to close.
        if ($ancestor -and -not ($ancestor.Name -eq '钊叔工具箱.exe' -and (Test-ToolkitPath $ancestor $roots))) { $protected += $id }
    }
    $known = @{}
    foreach ($process in @(Get-ToolkitTargets $all $roots $protected)) { $known[[int]$process.ProcessId] = $process }
    if ($known.Count -eq 0) { Write-InstallLog '工具箱相关进程已退出。'; return }
    Write-InstallLog ('正在正常关闭工具箱，相关进程数：' + $known.Count)
    foreach ($process in @($known.Values)) {
        $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($live -and $live.MainWindowHandle -ne 0) { [void]$live.CloseMainWindow() }
    }
    Start-Sleep -Seconds 8
    # Re-enumerate to include late-spawned processes; retain already captured orphan children.
    for ($round = 0; $round -lt 3; $round++) {
        $all = @(Get-CimInstance Win32_Process)
        foreach ($process in @(Get-ToolkitTargets $all $roots $protected)) { $known[[int]$process.ProcessId] = $process }
        foreach ($process in @($known.Values | Sort-Object CreationDate -Descending)) {
            $current = $all | Where-Object { $_.ProcessId -eq $process.ProcessId } | Select-Object -First 1
            if (-not (Test-SameProcess $process $current)) { continue }
            try {
                Write-InstallLog ('清理残留：' + $process.Name + ' PID=' + $process.ProcessId)
                $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
                if ($live -and ([math]::Abs(($live.StartTime.ToUniversalTime() - $process.CreationDate.ToUniversalTime()).Ticks) -lt 10)) {
                    $live.Kill()
                    [void]$live.WaitForExit(3000)
                }
            } catch { Write-InstallLog ('未能结束 PID=' + $process.ProcessId + '：' + $_.Exception.Message) }
        }
        Start-Sleep -Milliseconds 500
    }
    $all = @(Get-CimInstance Win32_Process)
    $remaining = @(Get-ToolkitTargets $all $roots $protected)
    foreach ($process in @($known.Values)) {
        $current = $all | Where-Object { $_.ProcessId -eq $process.ProcessId } | Select-Object -First 1
        if (Test-SameProcess $process $current) { $remaining += $current }
    }
    if ($remaining.Count -gt 0) { throw '仍有工具箱进程未退出；请以管理员身份重试安装。相关 PID：' + (($remaining.ProcessId | Select-Object -Unique) -join ',') }
    Write-InstallLog '工具箱相关进程已全部退出，可以安装。'
}

if (-not $LibraryOnly) {
    try { Stop-ToolkitProcesses; exit 0 }
    catch {
        try { Write-InstallLog $_.Exception.Message } catch { Write-Output $_.Exception.Message }
        exit 1
    }
}
