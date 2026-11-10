param([Parameter(Mandatory=$true)][string]$ReleaseDirectory, [string]$PreviousReleaseDirectory)
$ErrorActionPreference = 'Stop'
$release = (Resolve-Path $ReleaseDirectory).Path
$manifest = Get-Content (Join-Path $release 'release-manifest.json') -Raw | ConvertFrom-Json
$installer = Join-Path $release ($manifest.artifacts | Where-Object { $_.file.EndsWith('.exe') }).file
$zip = Join-Path $release ($manifest.artifacts | Where-Object { $_.file.EndsWith('.zip') }).file
$roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
function Installed {
  @($roots | Where-Object { Test-Path $_ } | ForEach-Object { Get-ChildItem $_ | Get-ItemProperty } | Where-Object { $_.DisplayName -eq 'HarnessHub' })
}
if (@(Installed).Count -ne 0) { throw 'Use an isolated Windows test account: HarnessHub is already installed.' }
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'HarnessHub.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'HarnessHub.lnk'
if ((Test-Path $shortcut) -or (Test-Path $desktopShortcut)) { throw 'Existing HarnessHub shortcuts must not be overwritten.' }
if (Get-Process HarnessHub -ErrorAction SilentlyContinue) { throw 'Close existing HarnessHub clients before isolated installer acceptance.' }
foreach ($artifact in $manifest.artifacts) {
  if ((Get-FileHash (Join-Path $release $artifact.file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256) { throw "Checksum mismatch: $($artifact.file)" }
}
if ((Get-AuthenticodeSignature $installer).Status -ne 'NotSigned') { throw 'Unsigned candidate has unexpected signature status.' }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('hhu-release-test-' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'installed'
$clientData = Join-Path $testRoot 'client-data'
$portable = Join-Path $testRoot 'portable'
New-Item -ItemType Directory -Path $testRoot,$clientData | Out-Null
$sentinel = Join-Path $clientData 'preserve-client-settings.txt'
[IO.File]::WriteAllText($sentinel, 'retained after upgrade and uninstall')
$checks = [Collections.Generic.List[string]]::new()
$ownedApp = $null
function Wait-Until($condition, $description) {
  $end = [DateTime]::UtcNow.AddSeconds(45)
  do { if (& $condition) { return }; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $end)
  throw "Timed out: $description"
}
function Launch-Client($exe) {
  $script:ownedApp = Start-Process -FilePath $exe -ArgumentList ('"--client-data-dir=' + $clientData + '"') -PassThru
  Wait-Until { $script:ownedApp.Refresh(); $script:ownedApp.MainWindowHandle -ne 0 } 'actual HarnessHub window'
  if ($script:ownedApp.MainWindowTitle -ne 'HarnessHub') { throw 'Unexpected application window title' }
}
function Close-Client {
  if ($script:ownedApp -and -not $script:ownedApp.HasExited) {
    if (-not $script:ownedApp.CloseMainWindow()) { throw 'Window refused normal close; inspect test process, no force-kill used.' }
    if (-not $script:ownedApp.WaitForExit(15000)) { throw 'Client has not exited; installer must not force-close it.' }
  }
  $script:ownedApp = $null
}
function Install-Candidate([string]$candidate = $installer) {
  # NSIS /D must be the final, unquoted argument, including when the path has spaces.
  $process = Start-Process -FilePath $candidate -ArgumentList ('/S /D=' + $installDir) -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "NSIS installation failed: $($process.ExitCode)" }
  if (-not (Test-Path (Join-Path $installDir 'HarnessHub.exe'))) { throw 'Installed exe missing' }
}
try {
  Expand-Archive -Path $zip -DestinationPath $portable
  $expectedAsar = (Get-FileHash (Join-Path $release 'win-unpacked\resources\app.asar') -Algorithm SHA256).Hash
  if ((Get-FileHash (Join-Path $portable 'resources\app.asar') -Algorithm SHA256).Hash -ne $expectedAsar) { throw 'ZIP payload differs from inspected app.asar' }
  Launch-Client (Join-Path $portable 'HarnessHub.exe')
  Close-Client
  $checks.Add('Portable ZIP starts real Windows window and closes normally using isolated client data')
  if ($PreviousReleaseDirectory) {
    $previousManifest = Get-Content (Join-Path $PreviousReleaseDirectory 'release-manifest.json') -Raw | ConvertFrom-Json
    $previousArtifact = $previousManifest.artifacts | Where-Object { $_.file.EndsWith('.exe') }
    $previousInstaller = Join-Path $PreviousReleaseDirectory $previousArtifact.file
    if ((Get-FileHash $previousInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $previousArtifact.sha256) { throw 'Previous installer checksum mismatch' }
    Install-Candidate $previousInstaller
    $checks.Add("Installed previous version fixture $($previousManifest.version)")
  } else { Install-Candidate }
  if (@(Installed).Count -ne 1 -or -not (Test-Path $shortcut)) { throw 'Missing uninstall registration or Start menu shortcut' }
  Launch-Client (Join-Path $installDir 'HarnessHub.exe')
  Close-Client
  Launch-Client (Join-Path $installDir 'HarnessHub.exe')
  # Deliberate crash of this test-owned client only; never a WSL/Daemon PID.
  if ($script:ownedApp.Path -ne (Join-Path $installDir 'HarnessHub.exe')) { throw 'Client process identity changed' }
  Stop-Process -Id $script:ownedApp.Id -ErrorAction Stop
  $script:ownedApp.WaitForExit()
  $script:ownedApp = $null
  Launch-Client (Join-Path $installDir 'HarnessHub.exe')
  Close-Client
  $checks.Add('Abnormal exit of verified test-owned Windows client followed by successful relaunch')
  $checks.Add('Fresh per-user NSIS install, Start menu shortcut, uninstall registration and actual application launch')
  $checks.Add('Portable to NSIS transition uses the same explicit client data directory')
  Install-Candidate
  if (-not (Test-Path $sentinel)) { throw 'Upgrade removed client settings' }
  if ((Get-FileHash (Join-Path $installDir 'resources\app.asar') -Algorithm SHA256).Hash -ne $expectedAsar) { throw 'Installed NSIS payload differs from inspected app.asar' }
  $checks.Add('ZIP and installed NSIS app.asar match the inspected staged payload byte-for-byte')
  Launch-Client (Join-Path $installDir 'HarnessHub.exe')
  Close-Client
  $checks.Add('Reinstall/upgrade installation preserves client settings and starts normally (different version when PreviousReleaseDirectory is supplied)')
  $uninstaller = Get-ChildItem $installDir -Filter '*Uninstall*.exe' | Select-Object -First 1
  if (-not $uninstaller) { throw 'Uninstaller missing' }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstall.ExitCode)" }
  Wait-Until { @(Installed).Count -eq 0 -and -not (Test-Path (Join-Path $installDir 'HarnessHub.exe')) } 'uninstall completion'
  if ((Test-Path $shortcut) -or -not (Test-Path $sentinel)) { throw 'Uninstall shortcut/data retention mismatch' }
  $checks.Add('Normal uninstall removes app and Start menu shortcut; independent client data preserved')
  Install-Candidate
  Launch-Client (Join-Path $installDir 'HarnessHub.exe')
  Close-Client
  if (-not (Test-Path $sentinel)) { throw 'Reinstall lost settings' }
  $checks.Add('Reinstall after uninstall starts normally and retains client data')
  @{ passed=$true; signing='unsigned'; platform='win32'; arch='x64'; testRoot=$testRoot; checks=$checks } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $testRoot 'installer-evidence.json')
} catch {
  @{ passed=$false; testRoot=$testRoot; checks=$checks; error=$_.Exception.Message } | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $testRoot 'installer-evidence.json')
  throw
} finally {
  Close-Client
  # Only the unique test-owned installation is eligible for cleanup; never delete directories.
  $record = @(Installed)
  if ($record.Count -eq 1 -and $record[0].UninstallString.StartsWith('"' + (Join-Path $installDir 'Uninstall HarnessHub.exe') + '"')) {
    $cleanup = Get-ChildItem $installDir -Filter '*Uninstall*.exe' | Select-Object -First 1
    if ($cleanup) {
      Start-Process -FilePath $cleanup.FullName -ArgumentList '/S' -Wait | Out-Null
      Wait-Until { @(Installed).Count -eq 0 } 'test uninstall cleanup'
    }
  }
  Write-Output "Installer evidence: $testRoot\installer-evidence.json"
}
