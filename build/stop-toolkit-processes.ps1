param(
    [string]$InstallDir,
    [string]$PreviousUserDir,
    [string]$PreviousMachineDir,
    [string]$LogPath = "$env:TEMP\toolkit-install-processes.log",
    [int]$InstallerPid,
    [string]$InstallerFile,
    [string]$RegistrationKey,
    [switch]$LibraryOnly
)
$ErrorActionPreference = 'Stop'
if ($InstallerPid -gt 0) { $env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules') }

function Get-ToolkitRoots([string[]]$Candidates) {
    $roots = @()
    foreach ($candidate in $Candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate -eq '\.') { continue }
        $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        # Accept only an existing toolbox installation, never a generic parent folder.
        if (Test-Path -LiteralPath (Join-Path $full '钊叔工具箱.exe') -PathType Leaf) {
            $roots += $full + '\'
        }
    }
    return @($roots | Select-Object -Unique)
}

function Get-RegisteredToolkitRoots {
    $caller = Get-CimInstance Win32_Process -Filter "ProcessId = $InstallerPid"
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if (-not $caller -or -not $caller.ExecutablePath -or $caller.SessionId -ne $sessionId -or
        [IO.Path]::GetFullPath($caller.ExecutablePath) -ne [IO.Path]::GetFullPath($InstallerFile)) {
        throw '无法确认请求清理的安装器。'
    }
    $owner = Invoke-CimMethod -InputObject $caller -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -notmatch '^S-1-[0-9-]+$') { throw '无法确认安装用户。' }
    # The NSIS installer registers x64 builds in the 64-bit registry. Read
    # the original user's hive even if UAC used a different administrator.
    $locations = foreach ($hive in @('Users', 'LocalMachine')) {
        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, 'Registry64')
        try {
            $subkey = if ($hive -eq 'Users') { $owner.Sid + '\' + $RegistrationKey } else { $RegistrationKey }
            $key = $registry.OpenSubKey($subkey)
            if ($key) {
                try { $key.GetValue('InstallLocation') } finally { $key.Dispose() }
            }
        } finally { $registry.Dispose() }
    }
    $roots = @(Get-ToolkitRoots $locations | Where-Object {
        Test-Path -LiteralPath (Join-Path $_ 'resources\app.asar') -PathType Leaf
    })
    if (-not $roots.Count) { throw '找不到已登记的旧版工具箱安装目录。' }
    return $roots
}

function Test-ToolkitPath($Process, [string[]]$Roots, [bool]$RegisteredOnly = $false) {
    if (-not $Process.ExecutablePath) { return $false }
    # Win32_Process can report an 8.3 alias even when the registry root has
    # already been expanded, e.g. RUNNER~1 vs runneradmin.
    $image = $Process.ExecutablePath
    if ($image.Contains('~')) {
        try { $image = [IO.Path]::GetFullPath($image) } catch { return $false }
    }
    foreach ($root in $Roots) {
        if ($image -eq ($root + '钊叔工具箱.exe')) { return $true }
        if ($RegisteredOnly) {
            if ($image -in @(($root + 'resources\python\python.exe'),
                ($root + 'resources\python\Lib\site-packages\playwright\driver\node.exe'))) { return $true }
        } elseif ($image.StartsWith(($root + 'resources\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Get-ToolkitTargets([object[]]$Processes, [string[]]$Roots, [int[]]$ProtectedIds, [bool]$RegisteredOnly = $false) {
    $selected = @{}
    foreach ($process in $Processes) {
        if ($ProtectedIds -contains [int]$process.ProcessId) { continue }
        if ($process.Name -match '^(Uninstall|setup|installer)' -or $process.Name -match '-win-(x64|arm64)\.exe$') { continue }
        if (Test-ToolkitPath $process $Roots $RegisteredOnly) { $selected[[int]$process.ProcessId] = $process }
    }
    if ($RegisteredOnly) { return @($selected.Values) }
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
    if (-not $InstallerPid) { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 }
    Write-Output $line
}

function Stop-ToolkitProcesses {
    $registeredOnly = $InstallerPid -gt 0
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $roots = if ($registeredOnly) { Get-RegisteredToolkitRoots } else {
        Get-ToolkitRoots @($InstallDir, $PreviousUserDir, $PreviousMachineDir)
    }
    Write-InstallLog '开始检查工具箱相关进程。'
    if ($roots.Count -eq 0) { Write-InstallLog '未发现旧工具箱安装目录。'; return }
    $all = @(Get-CimInstance Win32_Process -Filter "SessionId = $sessionId")
    if (@($all | Where-Object { $_.Name -eq '钊叔工具箱.exe' -and -not $_.ExecutablePath }).Count -gt 0) {
        throw [UnauthorizedAccessException]::new('无法读取旧版工具箱进程路径，需要 Windows 授权。')
    }
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
    foreach ($process in @(Get-ToolkitTargets $all $roots $protected $registeredOnly)) { $known[[int]$process.ProcessId] = $process }
    if ($known.Count -eq 0) { Write-InstallLog '工具箱相关进程已退出。'; return }
    Write-InstallLog ('正在正常关闭工具箱，相关进程数：' + $known.Count)
    foreach ($process in @($known.Values)) {
        $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($live) {
            try {
                if ($live.MainWindowHandle -ne 0) { [void]$live.CloseMainWindow() }
            } catch { Write-InstallLog ('无法正常关闭 PID=' + $process.ProcessId) }
            finally { $live.Dispose() }
        }
    }
    Start-Sleep -Seconds 8
    # Re-enumerate to include late-spawned processes; retain already captured orphan children.
    for ($round = 0; $round -lt 3; $round++) {
        $all = @(Get-CimInstance Win32_Process -Filter "SessionId = $sessionId")
        foreach ($process in @(Get-ToolkitTargets $all $roots $protected $registeredOnly)) { $known[[int]$process.ProcessId] = $process }
        foreach ($process in @($known.Values | Sort-Object CreationDate -Descending)) {
            $current = $all | Where-Object { $_.ProcessId -eq $process.ProcessId } | Select-Object -First 1
            if (-not (Test-SameProcess $process $current)) { continue }
            $live = $null
            try {
                Write-InstallLog ('清理残留：' + $process.Name + ' PID=' + $process.ProcessId)
                $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
                if ($live -and ([math]::Abs(($live.StartTime.ToUniversalTime() - $process.CreationDate.ToUniversalTime()).Ticks) -lt 10)) {
                    $live.Kill()
                    [void]$live.WaitForExit(3000)
                }
            } catch { Write-InstallLog ('未能结束 PID=' + $process.ProcessId + '：' + $_.Exception.Message) }
            finally { if ($live) { $live.Dispose() } }
        }
        Start-Sleep -Milliseconds 500
    }
    $all = @(Get-CimInstance Win32_Process -Filter "SessionId = $sessionId")
    $remaining = @(Get-ToolkitTargets $all $roots $protected $registeredOnly)
    foreach ($process in @($known.Values)) {
        $current = $all | Where-Object { $_.ProcessId -eq $process.ProcessId } | Select-Object -First 1
        if (Test-SameProcess $process $current) { $remaining += $current }
    }
    if ($remaining.Count -gt 0) {
        $ids = ($remaining.ProcessId | Select-Object -Unique) -join ','
        throw [UnauthorizedAccessException]::new("旧版仍有进程占用文件，需要 Windows 授权。相关 PID：$ids")
    }
    Write-InstallLog '工具箱相关进程已全部退出，可以安装。'
}

if (-not $LibraryOnly) {
    try { Stop-ToolkitProcesses; exit 0 }
    catch [UnauthorizedAccessException] {
        try { Write-InstallLog $_.Exception.Message } catch { Write-Output $_.Exception.Message }
        exit 5
    }
    catch {
        try { Write-InstallLog $_.Exception.Message } catch { Write-Output $_.Exception.Message }
        exit 1
    }
}
