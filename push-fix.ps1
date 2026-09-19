# push-fix.ps1 — stage the URI crash fix, commit, push to GitHub
# (Run from the Server folder is not required; uses absolute paths.)

$Server = "C:\Users\User\Downloads\IGG-VIP-SERVER-STICKERS-UPDATED\Server"

# 1. Kill the stuck local build (free the log file handle)
$nodeBuild = Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.CPU -gt 10 -or $_.WorkingSet -gt 80MB } |
  Sort-Object WorkingSet -Descending | Select-Object -First 1
if ($nodeBuild) {
  Write-Output ("Killing stuck build node PID $($nodeBuild.Id)")
  Stop-Process -Id $nodeBuild.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep 3
}

# 2. Stage the renames + map update (git detects the renames)
Set-Location $Server
git add -A
$staged = git status --short
Write-Output "Staged:`n$staged"

# 3. Commit
git -c user.name="Aditya4650-am" -c user.email="Aditya4650-am@users.noreply.github.com" `
  commit -m "fix: remove special chars from game-icon filenames (URI crash)"

# 4. Push to GitHub (may open a sign-in browser window)
git push
Write-Output "Push complete."
