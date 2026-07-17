# Removes the two inbound firewall rules added for phone testing.
#
# Requires Administrator. Run with:
#   powershell -ExecutionPolicy Bypass -File "C:\MY NEW APP\scripts\remove-firewall-rules.ps1"

$names = @(
  "Half-Dinar Dev - Expo dev server (8081)",
  "Half-Dinar Dev - API (3000)"
)

foreach ($name in $names) {
  $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  if ($rule) {
    Remove-NetFirewallRule -DisplayName $name
    Write-Output "Removed: $name"
  } else {
    Write-Output "Not present: $name"
  }
}

Write-Output ""
Write-Output "Remaining Half-Dinar rules (should be none):"
$left = Get-NetFirewallRule -DisplayName "Half-Dinar Dev*" -ErrorAction SilentlyContinue
if ($left) { $left | ForEach-Object { "  " + $_.DisplayName } } else { Write-Output "  none" }
