$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../build/stop-toolkit-processes.ps1" -LibraryOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
$t = [datetime]'2026-11-16T09:00:00Z'
function P($Id, $ParentId, $Name, $File, $Offset = 0) {
    [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $ParentId; Name = $Name; ExecutablePath = $File; CreationDate = $t.AddSeconds($Offset) }
}
$root = 'C:\Apps\钊叔工具箱\'
$processes = @(
    (P 10 1 '钊叔工具箱.exe' ($root + '钊叔工具箱.exe')),
    (P 11 10 '钊叔工具箱.exe' ($root + '钊叔工具箱.exe') 1),
    (P 12 10 'python.exe' ($root + 'resources\python\python.exe') 2),
    (P 13 12 'chrome.exe' 'C:\Program Files\Chrome\chrome.exe' 3),
    (P 14 13 'chrome.exe' 'C:\Program Files\Chrome\chrome.exe' 4),
    (P 15 1 'python.exe' 'C:\Python\python.exe'),
    (P 16 1 'chrome.exe' 'C:\Program Files\Chrome\chrome.exe'),
    (P 17 1 'python.exe' 'C:\Apps\钊叔工具箱-other\python.exe'),
    (P 18 10 'installer.exe' ($root + 'installer.exe') 5),
    (P 19 10 'powershell.exe' 'C:\Windows\powershell.exe' 5),
    (P 20 1 'python.exe' ($root + 'resources\python\python.exe') 2),
    (P 21 10 'unrelated.exe' 'C:\Unrelated\unrelated.exe' -10),
    (P 22 1 'another-app.exe' ($root + 'another-app.exe'))
)
$selected = @(Get-ToolkitTargets $processes @($root) @(19) | Sort-Object ProcessId)
Assert (($selected.ProcessId -join ',') -eq '10,11,12,13,14,20') 'Scope must include orphan runtime and descendants, exclude unrelated processes, helper, installer and reused parent IDs'
$reused = P 12 10 'python.exe' ($root + 'resources\python\python.exe') 20
Assert (-not (Test-SameProcess $processes[2] $reused)) 'Reused PID must not be killed'
Assert (Test-SameProcess $processes[2] $processes[2]) 'Same creation timestamp and executable should match'
Assert (@(Get-ToolkitTargets @() @($root) @()).Count -eq 0) 'No process is a successful empty selection'
Write-Output 'PASS: Windows process selection, path boundaries, orphan children, protected installer/helper and PID reuse'
