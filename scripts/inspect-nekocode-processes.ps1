# Inspect only NekoCode's process tree. No processes are stopped or reconfigured.
param(
    [int]$RootProcessId = 0,
    [string]$OutputPath
)

$allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
if ($RootProcessId -gt 0) {
    $roots = @($allProcesses | Where-Object { $_.ProcessId -eq $RootProcessId })
} else {
    $appProcesses = @($allProcesses | Where-Object { $_.Name -match '^NekoCode(?: Desktop)?\.exe$' })
    $appIds = @($appProcesses | ForEach-Object { $_.ProcessId })
    $roots = @($appProcesses | Where-Object { $_.ParentProcessId -notin $appIds })
}
if (-not $roots.Count) { throw 'NekoCode is not running, or specify -RootProcessId for a development build.' }

$children = @{}
foreach ($processEntry in $allProcesses) {
    $parentKey = [string]$processEntry.ParentProcessId
    if (-not $children.ContainsKey($parentKey)) { $children[$parentKey] = @() }
    $children[$parentKey] += $processEntry
}
$queue = [System.Collections.Generic.Queue[object]]::new()
foreach ($root in $roots) { $queue.Enqueue($root) }
$seen = [System.Collections.Generic.HashSet[int]]::new()
$details = @(
    while ($queue.Count) {
        $entry = $queue.Dequeue()
        if (-not $seen.Add([int]$entry.ProcessId)) { continue }
        $category = switch -Regex ($entry.Name) {
            '^NekoCode(?: Desktop)?\.exe$' {
                if ($entry.CommandLine -match '@agentclientprotocol|ELECTRON_RUN_AS_NODE|--input-type=module') { 'ACP adapter' }
                elseif ($entry.CommandLine -match '--type=renderer') { 'Electron renderer' }
                elseif ($entry.CommandLine -match '--type=gpu-process') { 'Electron GPU' }
                elseif ($entry.CommandLine -match '--type=utility') { 'Electron utility' }
                else { 'Electron app/helper' }
                break
            }
            '^codex\.exe$' { if ($entry.CommandLine -match '\bapp-server\b') { 'Codex app-server' } else { 'Codex helper' }; break }
            '^(cmd|powershell|pwsh|conhost|OpenConsole)\.exe$' { 'Shell/console'; break }
            '^(node|bun|bunx|npx)\.exe$' { 'Node/runtime helper'; break }
            default { 'Other child process' }
        }
        [PSCustomObject]@{
            ProcessId = [int]$entry.ProcessId
            ParentProcessId = [int]$entry.ParentProcessId
            Name = $entry.Name
            Category = $category
            WorkingSetMB = [Math]::Round([double]$entry.WorkingSetSize / 1MB, 1)
        }
        foreach ($child in $children[[string]$entry.ProcessId]) { $queue.Enqueue($child) }
    }
)
$report = [PSCustomObject]@{
    CapturedAt = [DateTime]::UtcNow.ToString('o')
    RootProcessIds = @($roots | ForEach-Object { [int]$_.ProcessId })
    ProcessCount = $details.Count
    WorkingSetMB = [Math]::Round(($details | Measure-Object WorkingSetMB -Sum).Sum, 1)
    Groups = @($details | Group-Object Category | ForEach-Object {
        [PSCustomObject]@{ Category = $_.Name; Count = $_.Count; WorkingSetMB = [Math]::Round(($_.Group | Measure-Object WorkingSetMB -Sum).Sum, 1) }
    })
    Processes = $details
}
if ($OutputPath) { $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding utf8 }
$report.Groups | Format-Table -AutoSize
$report.Processes | Format-Table -AutoSize
Write-Output ("Total: {0} processes, {1} MB working set" -f $report.ProcessCount, $report.WorkingSetMB)
