param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [Parameter(Mandatory=$true)][string]$Replacement
)
$ErrorActionPreference = 'Stop'

function Get-UninstallerIntegrity([byte[]]$Bytes) {
    # NSIS firstheader starts on a 512-byte boundary. Only classify NSIS
    # uninstallers with an embedded CRC and a complete, bounded payload.
    if ($Bytes.Length -lt 544 -or $Bytes[0] -ne 77 -or $Bytes[1] -ne 90) { return 'Unknown' }
    for ($header = 512; $header + 28 -le $Bytes.Length; $header += 512) {
        if ([BitConverter]::ToUInt32($Bytes, $header + 4) -ne [uint32]3735928559 -or
            [Text.Encoding]::ASCII.GetString($Bytes, $header + 8, 12) -cne 'NullsoftInst') { continue }
        $flags = [BitConverter]::ToUInt32($Bytes, $header)
        $size = [BitConverter]::ToUInt32($Bytes, $header + 24)
        if ($flags -gt 15 -or -not ($flags -band 1) -or ($flags -band 4) -or
            $size -lt 32 -or [long]$header + $size -gt $Bytes.Length) { return 'Unknown' }
        $end = $header + $size - 4
        $table = [uint32[]]::new(256)
        for ($i = 0; $i -lt 256; $i++) {
            $value = [uint32]$i
            for ($bit = 0; $bit -lt 8; $bit++) {
                if ($value -band 1) { $value = ($value -shr 1) -bxor [uint32]3988292384 }
                else { $value = $value -shr 1 }
            }
            $table[$i] = $value
        }
        $crc = [uint32]::MaxValue
        for ($i = 512; $i -lt $end; $i++) {
            $crc = $table[($crc -bxor $Bytes[$i]) -band 255] -bxor ($crc -shr 8)
        }
        if (($crc -bxor [uint32]::MaxValue) -eq [BitConverter]::ToUInt32($Bytes, $end)) { return 'Valid' }
        return 'BadCrc'
    }
    return 'Unknown'
}

try {
    $target = Join-Path $InstallDir 'Uninstall 钊叔工具箱.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '钊叔工具箱.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\app.asar') -PathType Leaf)) { exit 0 }
    $item = Get-Item -LiteralPath $target
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16MB) { exit 0 }
    if ((Get-UninstallerIntegrity ([IO.File]::ReadAllBytes($target))) -ne 'BadCrc') { exit 0 }

    # Never change a checksum or execute the damaged binary. Install the
    # working uninstaller carried by the SHA-256-verified incoming release.
    $newBytes = [IO.File]::ReadAllBytes($Replacement)
    if ((Get-UninstallerIntegrity $newBytes) -ne 'Valid') { throw '新版卸载器完整性校验失败。' }
    $temporary = Join-Path $InstallDir ('.toolkit-uninstall-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $stream = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
        try { $stream.Write($newBytes, 0, $newBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        [IO.File]::Replace($temporary, $target, [System.Management.Automation.Language.NullString]::Value)
    } finally { [IO.File]::Delete($temporary) }
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' 已修复旧版卸载器校验错误。'
    Add-Content -LiteralPath "$env:TEMP\toolkit-install-processes.log" -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    Write-Output $line
    exit 0
} catch {
    $detail = '旧版卸载器修复失败：' + $_.Exception.Message
    Add-Content -LiteralPath "$env:TEMP\toolkit-install-processes.log" -Value $detail -Encoding UTF8 -ErrorAction SilentlyContinue
    Write-Output $detail
    exit 13
}
