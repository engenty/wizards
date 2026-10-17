# engenty wizards - installer for Windows.
#
#   irm https://engenty.ai/install.ps1 | iex
#
# It needs Windows 10 or 11. It asks for an administrator only once, and only where Windows lacks
# Microsoft's Visual C++ runtime, which the runtime's database needs. Everything else goes into
# %USERPROFILE%\.engenty\wizards (ENGENTY_HOME moves it), as install.sh does on macOS and Linux:
#
#   tools\node-v<version>\   its own Node; a Node you already have is left alone
#   runtime\<version>\       the runtime, from the GitHub release; runtime\current is the one
#                            the command starts (a junction, which needs no administrator)
#   bin\wizards.cmd          the command, its folder on your PATH
#   data\                    your wizards and results (made at the first start)
#
# Then the guided setup runs (`wizards setup`). Running the installer again updates an install;
# your data is kept.
#
# Its Node is the x64 one on every Windows: a database library the runtime uses has no build for
# Windows on Arm, and Windows 11 on Arm runs x64 programs.
#
# Run as a file it takes options (`update` and `npx wizards` do that):
#
#   -Yes             ask nothing and install nothing optional
#   -NoSetup         only Node, the runtime and the command (what `update` runs)
#   -Version <v>     this version instead of the newest
#   -Local           no account: nothing leaves this computer
#
# For tests: ENGENTY_WIZARDS_PACKAGE (an npm spec or a tarball instead of the release's package),
# ENGENTY_WIZARDS_NODE_VERSION.
#
# Written for the Windows PowerShell 5.1 that Windows ships, in ASCII only: `irm | iex` reads it
# as text.
param(
  [switch]$Yes,
  [switch]$NoSetup,
  [string]$Version = "",
  [switch]$Local
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$NodeVersion = if ($env:ENGENTY_WIZARDS_NODE_VERSION) { $env:ENGENTY_WIZARDS_NODE_VERSION } else { "24.14.0" }
$Package = "@engenty/wizards-runtime"
$PackageFile = "engenty-wizards-runtime"
$Releases = "https://github.com/engenty/wizards/releases"
$Base = if ($env:ENGENTY_HOME) { $env:ENGENTY_HOME } else { Join-Path $HOME ".engenty" }
$HomeDir = Join-Path $Base "wizards"
$Tools = Join-Path $HomeDir "tools"
$NodeDir = Join-Path $Tools "node-v$NodeVersion"
$BinDir = Join-Path $HomeDir "bin"
$Wrapper = Join-Path $BinDir "wizards.cmd"
$Log = Join-Path $HomeDir "logs\install.log"
$script:Step = "The installer"

function Say($text, $detail = "") {
  Write-Host "  + " -ForegroundColor Green -NoNewline
  Write-Host $text -NoNewline
  if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray } else { Write-Host "" }
}

# A failure ends the installer, not the window: under `irm | iex`, `exit` would close the
# PowerShell the person typed into, and the message with it.
function Fail($text) { throw [InstallFailed]::new($text) }
class InstallFailed : Exception { InstallFailed([string]$m) : base($m) {} }

function Show-Failure($text) {
  Write-Host "  x $text" -ForegroundColor Red
  if (Test-Path $Log) {
    Get-Content $Log -Tail 12 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Host "  The whole log: $Log" -ForegroundColor DarkGray
  }
}

# The exit code for a caller that ran this file (update, npx wizards); nothing under `irm | iex`.
function Done($code) { if ($PSCommandPath) { exit $code } }

function Tilde($path) {
  if ($path.StartsWith($HOME)) { return "~" + $path.Substring($HOME.Length) }
  return $path
}

# --- the steps -------------------------------------------------------------------------------

function Check-Platform {
  $script:Step = "Looking at this machine"
  if (-not [Environment]::Is64BitOperatingSystem) { Fail "32-bit Windows is not supported." }
  # The machine's, not this process's: run from an emulated x64 program, Windows on Arm says AMD64.
  $arch = $env:PROCESSOR_ARCHITECTURE
  try { $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch {}
  if ($arch -eq "X64") { $arch = "AMD64" }
  $os = [Environment]::OSVersion.Version
  if ($os.Major -lt 10) { Fail "Windows 10 or 11 is needed." }
  $note = if ($arch -eq "ARM64") { "the x64 Node, which Windows on Arm runs" } else { "" }
  Say "Windows $($os.Major).$($os.Build) on $($arch.ToLower())" $note
}

function Install-Node {
  $script:Step = "Installing Node $NodeVersion"
  $node = Join-Path $NodeDir "node.exe"
  if ((Test-Path $node) -and ((& $node --version) -eq "v$NodeVersion")) {
    Link-Node
    Say "Node $NodeVersion" "already here"
    return
  }
  $name = "node-v$NodeVersion-win-x64"
  $dist = "https://nodejs.org/dist/v$NodeVersion"
  $tmp = Join-Path $Tools (".node." + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    Write-Host "  ... Downloading Node $NodeVersion" -ForegroundColor DarkGray
    Invoke-WebRequest -UseBasicParsing "$dist/$name.zip" -OutFile "$tmp\node.zip"
    # The file must be the one nodejs.org lists.
    $sums = (Invoke-WebRequest -UseBasicParsing "$dist/SHASUMS256.txt").Content
    $expected = ($sums -split "`n" | Where-Object { $_ -match "\s$name\.zip$" } | ForEach-Object { ($_ -split "\s+")[0] })
    $actual = (Get-FileHash "$tmp\node.zip" -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { Fail "The Node download does not match its checksum from nodejs.org." }
    Write-Host "  ... Unpacking Node $NodeVersion" -ForegroundColor DarkGray
    # Windows' own tar reads a zip many times faster than Expand-Archive.
    $tar = Join-Path $env:SystemRoot "System32\tar.exe"
    if (Test-Path $tar) {
      & $tar -xf "$tmp\node.zip" -C $tmp
      if ($LASTEXITCODE -ne 0) { Fail "Node could not be unpacked." }
    } else {
      Expand-Archive "$tmp\node.zip" -DestinationPath $tmp -Force
    }
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item (Join-Path $tmp $name) $NodeDir
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  Link-Node
  # An older Node of ours is not needed any more.
  Get-ChildItem $Tools -Directory -Filter "node-v*" | Where-Object { $_.FullName -ne $NodeDir } |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  Say "Node $NodeVersion" "$(Tilde (Join-Path $Tools 'node')), checksum from nodejs.org matches"
}

# tools\node points at the Node of this version: a junction, which needs no administrator.
function Link-Node {
  $link = Join-Path $Tools "node"
  if (Test-Path $link) { (Get-Item $link).Delete() }
  New-Item -ItemType Junction -Path $link -Target $NodeDir | Out-Null
}

# The database library is built with Microsoft's compiler and needs its runtime, which many
# programs bring along but a new Windows lacks. Microsoft's installer for it needs an administrator:
# Windows asks once.
function Install-VCRuntime {
  $script:Step = "Installing Microsoft's Visual C++ runtime"
  $keys = @(
    "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
  )
  foreach ($key in $keys) {
    if ((Get-ItemProperty $key -ErrorAction SilentlyContinue).Installed -eq 1) {
      Say "Microsoft Visual C++ runtime" "already here"
      return
    }
  }
  $url = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
  $exe = Join-Path $Tools "vc_redist.x64.exe"
  Write-Host "  ... Downloading Microsoft's Visual C++ runtime, which the database needs" -ForegroundColor DarkGray
  Invoke-WebRequest -UseBasicParsing $url -OutFile $exe
  try {
    $signature = Get-AuthenticodeSignature $exe
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "O=Microsoft Corporation") {
      Fail "The Visual C++ runtime download is not signed by Microsoft."
    }
    Write-Host "  ... Windows asks whether Microsoft's installer may make changes: say yes" -ForegroundColor DarkGray
    try {
      $process = Start-Process $exe -ArgumentList "/install", "/quiet", "/norestart" -Verb RunAs -Wait -PassThru
    } catch {
      Fail "The Visual C++ runtime was not installed. engenty wizards needs it: $url"
    }
    # 3010: installed, Windows wants a restart; 1638: a newer one is there.
    if (@(0, 3010, 1638) -notcontains $process.ExitCode) {
      Fail "Microsoft's Visual C++ installer ended with $($process.ExitCode). Install it yourself: $url"
    }
  } finally {
    Remove-Item -Force $exe -ErrorAction SilentlyContinue
  }
  Say "Microsoft Visual C++ runtime" "installed"
}

# What gets installed, decided before anything is downloaded: the tarball of the GitHub release,
# which npm installs like one from its registry; what it depends on comes from the registry.
function Find-Package {
  $script:Step = "Looking for the newest release"
  if ($env:ENGENTY_WIZARDS_PACKAGE) { return $env:ENGENTY_WIZARDS_PACKAGE }
  $v = $Version
  if (-not $v) {
    $latest = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/engenty/wizards/releases/latest"
    $v = $latest.tag_name -replace "^v", ""
  }
  if (-not $v) { Fail "No release of engenty wizards was found at $Releases." }
  return "$Releases/download/v$v/$PackageFile-$v.tgz"
}

# Each version has its folder (runtime\<version>\, an npm prefix) and `current` names the one the
# command starts, as install.sh does it: a version that runs keeps its files.
function Install-Runtime($spec) {
  $script:Step = "Installing engenty wizards"
  $runtime = Join-Path $HomeDir "runtime"
  New-Item -ItemType Directory -Force $runtime | Out-Null
  $stage = Join-Path $runtime (".staging-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  Write-Host "  ... Installing engenty wizards (about 650 MB on disk, a few minutes)" -ForegroundColor DarkGray
  $node = Join-Path $NodeDir "node.exe"
  $npm = Join-Path $NodeDir "node_modules\npm\bin\npm-cli.js"
  # Our Node first on the PATH, for npm and whatever it starts. No install scripts run; the
  # runtime works without them. --legacy-peer-deps: the dependencies as the package names them.
  $env:Path = "$NodeDir;$env:Path"
  # npm warns on stderr, which Windows PowerShell turns into errors that stop the script.
  $ErrorActionPreference = "Continue"
  & $node $npm install --prefix $stage --omit=dev --ignore-scripts --legacy-peer-deps `
    --no-audit --no-fund --loglevel=error $spec *>> $Log
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  $manifest = Join-Path $stage "node_modules\$Package\package.json"
  if ($code -ne 0 -or -not (Test-Path $manifest)) {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
    Fail "$script:Step failed."
  }
  $script:Installed = (Get-Content $manifest -Raw | ConvertFrom-Json).version
  $current = Join-Path $runtime "current"
  $previous = if (Test-Path $current) { Split-Path -Leaf ((Get-Item $current).Target | Select-Object -First 1) } else { "" }
  $into = Join-Path $runtime $script:Installed
  if (Test-Path $into) { Remove-Item -Recurse -Force $into }
  Move-Item $stage $into
  if (Test-Path $current) { (Get-Item $current).Delete() }
  New-Item -ItemType Junction -Path $current -Target $into | Out-Null
  # This version and the one before stay; older ones go (one that still runs keeps its files).
  Get-ChildItem $runtime -Directory | Where-Object { $_.Name -match "^\d+\.\d+\.\d+$" -and $_.Name -ne $script:Installed -and $_.Name -ne $previous } |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  Say "engenty wizards $script:Installed" (Tilde $into)
}

function Write-Command {
  $script:Step = "Writing the command"
  New-Item -ItemType Directory -Force $BinDir | Out-Null
  $lines = @(
    "@echo off",
    "rem engenty wizards - written by install.ps1; running the installer again rewrites it."
  )
  # An install outside ~\.engenty finds its folder again through the command.
  if ($Base -ne (Join-Path $HOME ".engenty")) {
    $lines += "if not defined ENGENTY_HOME set ""ENGENTY_HOME=$Base"""
  }
  $lines += """$(Join-Path $Tools 'node\node.exe')"" ""$(Join-Path $HomeDir "runtime\current\node_modules\$Package\bin\wizards.mjs")"" %*"
  Set-Content -Path $Wrapper -Value $lines -Encoding Ascii
  # The command's folder on the user's PATH; a terminal opened before sees it after a restart.
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ($userPath) { $userPath -split ";" } else { @() }
  if ($entries -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable("Path", (($entries + $BinDir) | Where-Object { $_ }) -join ";", "User")
    Say "Command" "$(Tilde $Wrapper), its folder added to your PATH"
  } else {
    Say "Command" (Tilde $Wrapper)
  }
  if (($env:Path -split ";") -notcontains $BinDir) { $env:Path = "$BinDir;$env:Path" }
}

# --- main ------------------------------------------------------------------------------------

New-Item -ItemType Directory -Force (Join-Path $HomeDir "logs"), $Tools, $BinDir | Out-Null
Add-Content $Log "`n--- $((Get-Date).ToUniversalTime().ToString('s'))Z install.ps1"
Write-Host ""
Write-Host "  engenty wizards" -ForegroundColor Magenta -NoNewline
Write-Host "  Make a wish. Get your wizard." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Installing into $(Tilde $HomeDir)"
$failed = $false
try {
  Check-Platform
  $spec = Find-Package
  Install-Node
  Install-VCRuntime
  Install-Runtime $spec
  Write-Command
} catch [InstallFailed] {
  Show-Failure $_.Exception.Message
  $failed = $true
} catch {
  Add-Content $Log $_.ToString()
  Show-Failure "$script:Step failed: $($_.Exception.Message)"
  $failed = $true
}

if ($failed) {
  Done 1
} elseif ($NoSetup) {
  Write-Host "  Installed engenty wizards $script:Installed."
  Done 0
} else {
  Write-Host "  Installed. The setup follows."
  Write-Host ""
  $setupArgs = @("setup")
  if ($Yes) { $setupArgs += "--yes" }
  if ($Local) { $setupArgs += "--local" }
  & $Wrapper @setupArgs
  Done $LASTEXITCODE
}
