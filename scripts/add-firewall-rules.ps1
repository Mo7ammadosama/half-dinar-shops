# Adds the two inbound firewall rules needed to test the customer app on a real phone.
#
# Scope: TCP ports 8081 (Expo dev server) and 3000 (backend API), restricted to
# the LOCAL SUBNET only — never the public internet. The network's Public/Private
# classification is deliberately left untouched.
#
# Requires Administrator. Run with:
#   powershell -ExecutionPolicy Bypass -File "C:\MY NEW APP\scripts\add-firewall-rules.ps1"
#
# To remove them again, see scripts\remove-firewall-rules.ps1

$rules = @(
  @{ Name = "Half-Dinar Dev - Expo dev server (8081)"; Port = 8081 },
  @{ Name = "Half-Dinar Dev - API (3000)";             Port = 3000 }
)

foreach ($rule in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Output "Already exists: $($rule.Name)"
    continue
  }

  New-NetFirewallRule `
    -DisplayName $rule.Name `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $rule.Port `
    -RemoteAddress LocalSubnet `
    -Profile Any `
    -ErrorAction Stop | Out-Null

  Write-Output "Created: $($rule.Name)"
}

Write-Output ""
Write-Output "Done. Current Half-Dinar rules:"
Get-NetFirewallRule -DisplayName "Half-Dinar Dev*" |
  ForEach-Object {
    $port = ($_ | Get-NetFirewallPortFilter).LocalPort
    $scope = ($_ | Get-NetFirewallAddressFilter).RemoteAddress
    "  {0} | port={1} | scope={2} | enabled={3}" -f $_.DisplayName, $port, $scope, $_.Enabled
  }
