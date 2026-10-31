$ErrorActionPreference = 'Stop'
$secure = Read-Host 'Discord test bot token (input is masked; it will not be saved)' -AsSecureString
$pointer = [IntPtr]::Zero
$token = $null
try {
  if ($secure.Length -eq 0) { throw 'Token input was empty.' }
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $headers = @{ Authorization = "Bot $token" }
  $identity = Invoke-RestMethod -Method Get -Uri 'https://discord.com/api/v10/users/@me' -Headers $headers -TimeoutSec 20
  if (-not $identity.id -or -not $identity.username) { throw 'Discord returned an incomplete bot identity.' }
  Write-Output "Authenticated Discord test bot: $($identity.username) (ID $($identity.id)). No database or bot actions were used."
}
catch {
  Write-Error 'Discord bot identity check failed. Confirm the token belongs to the test application and is still valid.'
  exit 1
}
finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  if ($secure) { $secure.Dispose() }
  $headers = $null
  $token = $null
}
