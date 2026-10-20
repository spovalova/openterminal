# Open Terminal installer for Windows (Windows PowerShell 5.1 and PowerShell 7).
#
#   irm https://terminal.spova.ai/install.ps1 | iex
#
# Downloads the setup program (OpenTerminal-win-x64-setup.exe) from GitHub Releases, checks it against the release's
# SHA256SUMS, closes Open Terminal if it is running, runs the setup silently (a per-user install: no administrator,
# nothing added to PATH) and opens the app. The setup is not signed with a code-signing certificate; a file that
# Invoke-WebRequest saves carries no Mark of the Web, so SmartScreen does not stop it. The app's Update can run this
# same script.
#
# Environment:
#   OPENTERMINAL_VERSION        a specific version (0.1.0 or v0.1.0) instead of the latest release
#   OPENTERMINAL_INSTALL_BASE   a base URL or a local directory holding the release assets and SHA256SUMS
#   OPENTERMINAL_NO_LAUNCH      1 to leave the app closed at the end
#   NO_COLOR                    plain output
#
# Everything below is one function called on the last lines, so a download cut short runs nothing. The file is ASCII
# on purpose: Windows PowerShell 5.1 reads a saved .ps1 without a byte order mark as ANSI.

function Install-OpenTerminal {
  Set-StrictMode -Version 2.0
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'https://github.com/spovalova/openterminal'
  $site = 'https://terminal.spova.ai'
  $asset = 'OpenTerminal-win-x64-setup.exe'
  $productName = 'Open Terminal'

  function Get-Env([string]$Name) {
    [Environment]::GetEnvironmentVariable($Name)
  }

  # ---------- output ----------

  $redirected = $false
  try { $redirected = [Console]::IsOutputRedirected } catch { $redirected = $true }
  $color = -not (Get-Env 'NO_COLOR') -and -not $redirected
  if ($redirected) {
    $ok = '+'; $no = 'x'; $about = '~'; $dot = '-'
  } elseif ((Get-Env 'WT_SESSION') -or (Get-Env 'TERM_PROGRAM') -eq 'vscode') {
    # Windows Terminal and VS Code have fonts with the check mark.
    $ok = [string][char]0x2713; $no = [string][char]0x2717; $about = [string][char]0x2248; $dot = [string][char]0x00B7
  } else {
    # The classic console's fonts (Consolas, Lucida Console) have these.
    $ok = [string][char]0x221A; $no = [string][char]0x00D7; $about = [string][char]0x2248; $dot = [string][char]0x00B7
  }

  function Write-Line([string]$Mark, [string]$MarkColor, [string]$Label, [string]$Value) {
    Write-Host '  ' -NoNewline
    if ($color) { Write-Host $Mark -ForegroundColor $MarkColor -NoNewline } else { Write-Host $Mark -NoNewline }
    Write-Host (' {0,-10} {1}' -f $Label, $Value)
  }
  function Write-Step([string]$Label, [string]$Value) { Write-Line $ok 'Green' $Label $Value }
  function Write-Warn([string]$Label, [string]$Value) { Write-Line '!' 'Yellow' $Label $Value }

  # A failed step: thrown, then printed with its hints by the catch at the end.
  function Stop-Install([string]$Label, [string]$Message, [string[]]$Hints = @()) {
    $e = New-Object System.Exception $Message
    $e.Data['openterminal.label'] = $Label
    $e.Data['openterminal.hints'] = $Hints
    throw $e
  }

  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  function Format-Path([string]$Path) {
    if ($localAppData -and $Path.StartsWith($localAppData, [StringComparison]::OrdinalIgnoreCase)) {
      return '%LOCALAPPDATA%' + $Path.Substring($localAppData.Length)
    }
    return $Path
  }

  function Format-Size([long]$Bytes) {
    if ($Bytes -ge 1MB) { return ('{0}{1:0} MB' -f $about, ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0}{1:0} KB' -f $about, ($Bytes / 1KB)) }
    return ('{0} bytes' -f $Bytes)
  }

  function Get-ErrorText($ErrorRecord) {
    $ex = $ErrorRecord.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    return $ex.Message
  }

  # A property of a registry value set, or $null (StrictMode forbids reading one that is not there).
  function Get-Prop($Object, [string]$Name) {
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return [string]$p.Value }
    return $null
  }

  # ---------- download ----------

  # Copy a local file, or download a URL. Invoke-WebRequest writes no Mark of the Web.
  function Get-Asset([string]$Source, [string]$Dest, [bool]$Progress) {
    if ($Source -notmatch '^https?://') {
      if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "no such file: $Source" }
      Copy-Item -LiteralPath $Source -Destination $Dest -Force
      return
    }
    # Windows PowerShell 5.1 crawls while it draws a progress bar; PowerShell 7 does not.
    $ProgressPreference = 'SilentlyContinue'
    if ($Progress -and $PSVersionTable.PSVersion.Major -ge 7) { $ProgressPreference = 'Continue' }
    Invoke-WebRequest -Uri $Source -OutFile $Dest -UseBasicParsing -UserAgent 'openterminal-installer'
  }

  # Where releases/latest points: .../releases/tag/v<version>, or .../releases when nothing is published yet.
  function Get-LatestUrl {
    try {
      $request = [System.Net.WebRequest]::Create("$repo/releases/latest")
      $request.Method = 'HEAD'
      $request.AllowAutoRedirect = $false
      $request.UserAgent = 'openterminal-installer'
      $request.Timeout = 20000
      $response = $request.GetResponse()
      try { return [string]$response.Headers['Location'] } finally { $response.Close() }
    } catch {
      # Some runtimes report the redirect as a WebException that still carries the response.
      $ex = $_.Exception
      while ($ex) {
        if ($ex -is [System.Net.WebException] -and $ex.Response) {
          try { return [string]$ex.Response.Headers['Location'] } finally { $ex.Response.Close() }
        }
        $ex = $ex.InnerException
      }
      return ''
    }
  }

  # ---------- the app ----------

  # The app's processes (the main one and Electron's helpers share its name). Wrapped in @() at every call, because
  # a function's empty result reaches the caller as $null.
  function Get-RunningApp {
    Get-Process -Name $productName -ErrorAction SilentlyContinue
  }

  # Ask a running Open Terminal to close its windows, as clicking X would, and wait; then end what is left.
  function Close-App {
    $running = @(Get-RunningApp)
    if ($running.Count -eq 0) { return $false }
    foreach ($p in $running) { try { $null = $p.CloseMainWindow() } catch { } }
    for ($i = 0; $i -lt 20 -and @(Get-RunningApp).Count -gt 0; $i++) { Start-Sleep -Seconds 1 }
    foreach ($p in @(Get-RunningApp)) { try { Stop-Process -Id $p.Id -Force } catch { } }
    Start-Sleep -Milliseconds 500
    return $true
  }

  # The installed app, from the per-user uninstall entry the setup writes, else the default per-user folder.
  function Find-App {
    $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    if (Test-Path -LiteralPath $keys) {
      foreach ($key in @(Get-ChildItem -LiteralPath $keys -ErrorAction SilentlyContinue)) {
        $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        $name = Get-Prop $props 'DisplayName'
        if (-not $name -or -not $name.StartsWith($productName)) { continue }
        $exe = $null
        $location = Get-Prop $props 'InstallLocation'
        if ($location) { $exe = Join-Path $location.Trim('"') "$productName.exe" }
        $icon = Get-Prop $props 'DisplayIcon'
        if ((-not $exe -or -not (Test-Path -LiteralPath $exe)) -and $icon) { $exe = ($icon -replace ',\s*-?\d+$', '').Trim('"') }
        if ($exe -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
          return @{ Exe = $exe; Version = (Get-Prop $props 'DisplayVersion') }
        }
      }
    }
    $programs = Join-Path $localAppData 'Programs'
    if (Test-Path -LiteralPath $programs) {
      foreach ($dir in @(Get-ChildItem -LiteralPath $programs -Directory -ErrorAction SilentlyContinue)) {
        $exe = Join-Path $dir.FullName "$productName.exe"
        if (Test-Path -LiteralPath $exe -PathType Leaf) { return @{ Exe = $exe; Version = $null } }
      }
    }
    return $null
  }

  # ---------- install ----------

  $tmp = $null
  try {
    Write-Host ''
    if ($color) { Write-Host '  Open Terminal installer' -ForegroundColor White } else { Write-Host '  Open Terminal installer' }

    # Platform
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
      Stop-Install 'platform' 'this is the Windows installer; on macOS and Linux, in a terminal:' @("curl -fsSL $site/install | sh")
    }
    $arch = Get-Env 'PROCESSOR_ARCHITEW6432'
    if (-not $arch) { $arch = Get-Env 'PROCESSOR_ARCHITECTURE' }
    $build = [Environment]::OSVersion.Version.Build
    switch ($arch) {
      'AMD64' { $platform = 'Windows x64' }
      'ARM64' {
        if ($build -lt 22000) {
          Stop-Install 'platform' 'Windows on ARM runs the x64 app from Windows 11 on; this is Windows 10.' @("Other systems: $repo#quick-start")
        }
        $platform = 'Windows ARM64 (the x64 app, emulated)'
      }
      default {
        Stop-Install 'platform' ("Open Terminal is built for 64-bit Windows; this machine is {0}." -f $arch) @("Other systems: $repo#quick-start")
      }
    }
    Write-Step 'platform' $platform

    # TLS 1.2 for Windows PowerShell 5.1 (GitHub refuses older protocols); harmless on PowerShell 7.
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }

    # Which release
    $want = ([string](Get-Env 'OPENTERMINAL_VERSION')).Trim()
    if ($want.StartsWith('v')) { $want = $want.Substring(1) }
    if ($want -notmatch '^[0-9A-Za-z.+-]*$') {
      Stop-Install 'setup' ("OPENTERMINAL_VERSION={0} is not a version (like 0.1.0)." -f $want)
    }
    $version = $want
    $base = [string](Get-Env 'OPENTERMINAL_INSTALL_BASE')
    $local = $false
    if ($base) {
      if ($base -match '^https?://') { $base = $base.TrimEnd('/') }
      elseif ($base -match '^file://') { $base = ([Uri]$base).LocalPath; $local = $true }
      else { $local = $true }
    } elseif ($want) {
      $base = "$repo/releases/download/v$want"
    } else {
      # Pin the latest release's tag, so the checksums and the setup come from the same release.
      $base = "$repo/releases/latest/download"
      $latest = Get-LatestUrl
      if ($latest -match '/releases/tag/v([0-9A-Za-z.+-]+)$') {
        $version = $Matches[1]
        $base = "$repo/releases/download/v$version"
      } elseif ($latest -match '/releases/?$') {
        Stop-Install 'download' 'no release of Open Terminal is published yet.' @("Releases: $repo/releases", "Until then, build it from source: $repo#quick-start")
      }
    }
    function Join-Base([string]$Name) {
      if ($local) { return (Join-Path $base $Name) }
      return "$base/$Name"
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('openterminal-' + [Guid]::NewGuid().ToString('N'))
    $null = [IO.Directory]::CreateDirectory($tmp)

    # Download: the checksums first (small, and the clearest failure), then the setup.
    $sums = Join-Path $tmp 'SHA256SUMS'
    try {
      Get-Asset (Join-Base 'SHA256SUMS') $sums $false
    } catch {
      Stop-Install 'download' ("could not get {0}" -f (Join-Base 'SHA256SUMS')) @((Get-ErrorText $_), "Releases: $repo/releases")
    }
    $expected = $null
    foreach ($line in [IO.File]::ReadAllLines($sums)) {
      $m = [regex]::Match($line, '^\s*([0-9a-fA-F]{64})\s+\*?(?:\./)?(\S+)\s*$')
      if ($m.Success -and $m.Groups[2].Value -eq $asset) { $expected = $m.Groups[1].Value.ToLowerInvariant(); break }
    }
    if (-not $expected) {
      Stop-Install 'download' ("SHA256SUMS at {0} has no entry for {1}" -f $base, $asset) @("Releases: $repo/releases")
    }

    # PowerShell 7 draws Invoke-WebRequest's own progress bar; on 5.1 a pending line stands in for it.
    $setup = Join-Path $tmp $asset
    $progress = -not $redirected -and $PSVersionTable.PSVersion.Major -ge 7
    $pendingText = ''
    if (-not $redirected -and -not $local -and -not $progress) {
      $pendingText = '  {0} {1,-10} {2}' -f $dot, 'download', $asset
      Write-Host $pendingText -NoNewline
    }
    try {
      Get-Asset (Join-Base $asset) $setup $progress
    } catch {
      if ($pendingText) { Write-Host '' }
      Stop-Install 'download' ("could not get {0}" -f (Join-Base $asset)) @((Get-ErrorText $_), "Releases: $repo/releases")
    }
    if ($pendingText) { Write-Host ("`r" + (' ' * $pendingText.Length) + "`r") -NoNewline }
    $bytes = (Get-Item -LiteralPath $setup).Length

    # Verify
    $actual = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Write-Step 'download' ('{0} ({1})' -f $asset, (Format-Size $bytes))
      Stop-Install 'verify' ("sha256 mismatch for {0}; nothing was installed." -f $asset) @("expected $expected", "got      $actual", "Try again; if it persists, report it: $repo/issues")
    }
    $label = $productName
    if ($version) { $label = "$productName $version" }
    Write-Step 'download' ('{0} ({1})' -f $label, (Format-Size $bytes))
    Write-Step 'verify' 'sha256'

    # Install: close the app, then the setup, silently, for this user.
    if (Close-App) { Write-Step 'quit' "the running $productName" }
    try {
      $process = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru
      $null = $process.Handle # keeps the exit code readable after the process ends
      $process.WaitForExit()
      $code = $process.ExitCode
    } catch {
      Stop-Install 'install' 'could not run the setup' @((Get-ErrorText $_))
    }
    if ($code -ne 0) {
      Stop-Install 'install' ("the setup ended with exit code {0}." -f $code) @("Run it yourself to see why: $(Join-Base $asset)")
    }
    $app = Find-App
    if (-not $app) {
      Stop-Install 'install' 'the setup finished, but Open Terminal is not where it should be.' @("Look for it in the Start menu, or report it: $repo/issues")
    }
    Write-Step 'install' (Format-Path (Split-Path -Parent $app.Exe))

    $launched = $false
    if ((Get-Env 'OPENTERMINAL_NO_LAUNCH') -ne '1') {
      try {
        $null = Start-Process -FilePath $app.Exe
        $launched = $true
        Write-Step 'open' $productName
      } catch {
        Write-Warn 'open' ('could not open it: {0}' -f (Get-ErrorText $_))
      }
    }

    Write-Host ''
    if ($launched) {
      Write-Host '  Open Terminal is in the Start menu. To update, run this again or use Update in the app.'
    } else {
      Write-Host '  Start it from the Start menu: Open Terminal.'
    }
    Write-Host ''
    return $true
  } catch {
    $ex = $_.Exception
    $label = 'error'
    $hints = @()
    if ($ex.Data.Contains('openterminal.label')) {
      $label = [string]$ex.Data['openterminal.label']
      $hints = @($ex.Data['openterminal.hints'])
    }
    Write-Host '  ' -NoNewline
    $first = '{0} {1,-10} {2}' -f $no, $label, $ex.Message
    if ($color) { Write-Host $first -ForegroundColor Red } else { Write-Host $first }
    foreach ($hint in $hints) {
      if ($hint) { Write-Host ('  {0}{1}' -f (' ' * 13), $hint) }
    }
    Write-Host ''
    return $false
  } finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { try { [IO.Directory]::Delete($tmp, $true) } catch { } }
  }
}

# irm | iex runs this in your session: leave nothing behind, and never `exit` (it would close the window).
$openterminalFailed = (Install-OpenTerminal) -ne $true
$openterminalFile = [bool](Get-Variable -Name PSCommandPath -ValueOnly -ErrorAction SilentlyContinue)
Remove-Item -LiteralPath 'Function:\Install-OpenTerminal' -ErrorAction SilentlyContinue
if ($openterminalFile -and $openterminalFailed) { exit 1 }
Remove-Variable -Name openterminalFailed, openterminalFile -ErrorAction SilentlyContinue
