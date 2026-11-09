# TradeProof local setup + verification script (Windows PowerShell 5.1+ / PowerShell 7)
#
# What it does (all inside this project folder, nothing global):
#   1. Records OS, Node.js, npm, Git and Claude Code versions.
#   2. Checks Node.js meets the project minimum (22.18, see $MinNode).
#   3. Installs dependencies locally (npm ci if a lockfile exists, otherwise npm install).
#   4. Runs lint, type-check, unit tests (mock PayPal, no network) and production build.
#   5. Scans the files that would be committed for secrets.
#   6. Initialises a local Git repo (if missing) and makes the initial commit.
#      No remote is added, nothing is pushed.
#
# It does NOT: change global npm/git config, install global packages, read .env.local values,
# create remotes, push, deploy, or call PayPal.
#
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-local.ps1
#   Optional switches:  -SkipCommit   -StartDev
#
# Results are printed and saved to docs\local-env-report.txt (Git-ignored).

param(
  [switch]$SkipCommit,
  [switch]$StartDev,
  [string]$CommitMessage = "chore: initial TradeProof scaffold (Next.js + TypeScript, docs, synthetic samples)"
)

# "Continue" so that warnings native tools print to stderr (npm, git) don't abort Windows PowerShell 5.1;
# each step is judged by its exit code instead.
$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$Report = Join-Path $ProjectRoot "docs\local-env-report.txt"
$MinNode = [version]"22.18.0"  # node:sqlite unflagged (22.13) + TypeScript test files without flags (22.18); Next.js 16 needs 20.9
$results = New-Object System.Collections.Generic.List[string]

function Log([string]$msg) {
  Write-Host $msg
  $script:results.Add($msg) | Out-Null
}
function Get-Ver([string]$cmd, [string]$arg = "--version") {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if (-not $c) { return "NOT FOUND" }
  try { return ((& $cmd $arg 2>&1) | Select-Object -First 1).ToString().Trim() } catch { return "ERROR: $($_.Exception.Message)" }
}
function Step([string]$name, [scriptblock]$block) {
  Log ""
  Log "== $name"
  $global:LASTEXITCODE = 0
  # A step fails on a non-zero exit code OR a PowerShell error (e.g. command not found),
  # which would otherwise leave LASTEXITCODE at 0 and be reported as PASS.
  $ok = $true
  try { & $block } catch { $ok = $false; Log "ERROR: $($_.Exception.Message)" }
  $code = $LASTEXITCODE
  if (-not $ok -or $code -ne 0) {
    if ($code -eq 0) { $code = 1 }
    Log "RESULT: FAIL ($name, exit code $code)"
    Save-Report
    exit $code
  }
  Log "RESULT: PASS ($name)"
}
function Save-Report { $script:results | Out-File -FilePath $Report -Encoding utf8 }

Log "TradeProof local setup report"
Log ("Date: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"))
Log ("Project: " + $ProjectRoot)

# ---- 1. Environment ----
Log ""
Log "== Environment"
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) { Log ("OS: " + $os.Caption + " " + $os.Version + " (" + $os.OSArchitecture + ")") } else { Log ("OS: " + [Environment]::OSVersion.VersionString) }
Log ("PowerShell: " + $PSVersionTable.PSVersion.ToString())
$nodeV = Get-Ver "node" "-v"
Log ("Node.js: " + $nodeV)
Log ("npm: " + (Get-Ver "npm.cmd" "-v"))
Log ("pnpm: " + (Get-Ver "pnpm.cmd" "-v"))
Log ("Git: " + (Get-Ver "git"))
Log ("Claude Code: " + (Get-Ver "claude"))

if ($nodeV -eq "NOT FOUND") { Log "BLOCKER: Node.js not found. Install Node.js LTS (>= $MinNode) from https://nodejs.org/ and re-run."; Save-Report; exit 1 }
$nodeParsed = [version]($nodeV.TrimStart("v"))
if ($nodeParsed -lt $MinNode) { Log "BLOCKER: Node.js $nodeV is below $MinNode required by Next.js. Upgrade Node (LTS) and re-run."; Save-Report; exit 1 }
Log "Node.js version OK (>= $MinNode)"
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Log "BLOCKER: npm not found (it ships with Node.js). Reinstall Node.js LTS and re-run."; Save-Report; exit 1 }

# ---- 2-4. Install, lint, type-check, build ----
if (Test-Path (Join-Path $ProjectRoot "package-lock.json")) {
  Step "npm ci (project-local install from lockfile)" { npm.cmd ci --no-audit --no-fund }
} else {
  Step "npm install (project-local, creates package-lock.json)" { npm.cmd install --no-audit --no-fund }
}
Step "Lint (eslint)" { npm.cmd run lint }
Step "Type-check (tsc --noEmit)" { npm.cmd run typecheck }
Step "Unit tests (node --test, MOCK PayPal, no network)" { npm.cmd test }
Step "Production build (next build)" { npm.cmd run build }

# ---- 5. Git ----
if ($SkipCommit) { Log ""; Log "Skipping Git commit (-SkipCommit)."; Save-Report }
else {
  if ((Get-Ver "git") -eq "NOT FOUND") { Log "BLOCKER: Git not found. Install from https://git-scm.com/ then re-run."; Save-Report; exit 1 }
  if (-not (Test-Path (Join-Path $ProjectRoot ".git"))) {
    Step "git init (local only, branch main)" { git init -b main }
  } else { Log "Git repo already exists; not re-initialising." }

  $remotes = git remote
  if ($remotes) { Log "NOTE: remotes exist ($remotes). This script never pushes." }

  $name = git config user.name; $email = git config user.email
  if (-not $name -or -not $email) {
    Log "BLOCKER: git user.name / user.email not set. Set them yourself (example, repo-only):"
    Log "  git config user.name ""Your Name""; git config user.email ""you@example.com"""
    Log "Then re-run this script. (Script does not change your global Git config.)"
    Save-Report; exit 1
  }

  # Only stage automatically in a repo with no commits yet. In an existing repo the index is
  # left exactly as the user had it (nothing added, nothing reset) and nothing is committed.
  $global:LASTEXITCODE = 0
  git rev-parse --verify -q HEAD 2>$null | Out-Null
  $hasCommits = ($LASTEXITCODE -eq 0)
  if (-not $hasCommits) {
    Step "git add -A (respects .gitignore)" { git add -A }
  } else {
    Log "Repo already has commits; not staging anything. Scanning what you already staged."
  }
  $staged = @(git -c core.quotepath=off diff --cached --name-only --diff-filter=d)
  Log ""
  Log "== Files staged for commit ($($staged.Count))"
  $staged | ForEach-Object { Log "  $_" }

  # Secret / sensitive-file scan on the STAGED content (what would actually be committed),
  # covering every staged file incl. package-lock.json and this script. Only file names and
  # pattern labels are printed, never matched values.
  Log ""
  Log "== Secret scan of staged files"
  $bad = @()
  foreach ($f in $staged) {
    if ($f -match '(^|/)\.env($|\.)' -and $f -notmatch '(^|/)\.env\.example$') { $bad += "$f (env file must not be committed)" }
    if ($f -match '\.(pem|key|p12|pfx)$') { $bad += "$f (key file)" }
    if ($f -match '^(node_modules|\.next|out|build|data)/' -or $f -match '\.(log|sqlite|sqlite3|db)$' -or $f -match '^docs/local-.*report\.') { $bad += "$f (build output / log / database / local report must not be committed)" }
  }
  $patterns = @(
    'A21AA[A-Za-z0-9_\-]{20,}',                       # PayPal access token prefix
    'sk-ant-[A-Za-z0-9_\-]{10,}',                      # Anthropic API key
    'sk-[A-Za-z0-9]{20,}',                             # generic OpenAI-style key
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    # secret-like name followed by a LITERAL value (quoted string) — not a code reference like `secret: env.X`
    '(?i)(client_secret|secret|api_key|apikey|access_token|password)["'']?[ \t]*[=:][ \t]*["''][^"''\s]{12,}["'']',
    # env-file style: NAME_WITH_SECRET=value (unquoted)
    '(?i)^[ \t]*(export[ \t]+)?[A-Z0-9_]*(SECRET|API_KEY|ACCESS_TOKEN|PASSWORD)[A-Z0-9_]*[ \t]*=[ \t]*[^\s"''#]{8,}'
  )
  $labels = @("PayPal access token", "Anthropic API key", "OpenAI-style key", "PEM private key", "secret-like literal", "env-style secret")
  # A line containing the marker "secret-scan: allow" is skipped (for reviewed, deliberately fake test
  # values). Every skipped line is listed in the report so the exception stays visible.
  foreach ($f in $staged) {
    $global:LASTEXITCODE = 0
    $lines = @(git show ":$f" 2>$null)
    if ($LASTEXITCODE -ne 0) { $bad += "$f (could not read staged content)"; continue }
    for ($n = 0; $n -lt $lines.Count; $n++) {
      $line = [string]$lines[$n]
      $hits = @()
      for ($i = 0; $i -lt $patterns.Count; $i++) { if ($line -match $patterns[$i]) { $hits += $labels[$i] } }
      if ($hits.Count -eq 0) { continue }
      if ($line -match 'secret-scan: allow') { Log "  allowed by reviewed marker: ${f}:$($n + 1) ($($hits -join ', '))"; continue }
      $bad += "${f}:$($n + 1) (possible $($hits -join ', '))"
    }
  }
  if ($bad.Count -gt 0) {
    Log "RESULT: FAIL - possible secrets or forbidden files staged. Nothing committed. Review:"
    $bad | ForEach-Object { Log "  $_" }
    if (-not $hasCommits) { git reset -q }   # undo only the staging this script did itself
    Save-Report; exit 1
  }
  Log "RESULT: PASS (no secret patterns or env/key/build/log files in staged set)"

  if ($hasCommits) {
    Log "Repo already has commits; no automatic commit. Review and commit your changes yourself."
  } elseif ($staged.Count -eq 0) {
    Log "Nothing staged; no commit made."
  } else {
    Step "Initial commit" { git commit -q -m $CommitMessage }
    Log ("Commit: " + (git log -1 --pretty=format:"%h %s"))
  }
  Save-Report
}

Log ""
Log "Done. Report saved to docs\local-env-report.txt"
Save-Report

if ($StartDev) {
  Log "Starting dev server at http://localhost:3000 (Ctrl+C to stop)"
  npm.cmd run dev
}
