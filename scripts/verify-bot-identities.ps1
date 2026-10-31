$ErrorActionPreference = 'Stop'
function Read-SecretText([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [IntPtr]::Zero
  try {
    if ($secure.Length -eq 0) { throw 'Input was empty.' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secure.Dispose()
  }
}

$discordToken = $null
$veiledToken = $null
try {
  $discordToken = Read-SecretText 'Discord test bot token (masked; not saved)'
  $veiledToken = Read-SecretText 'Veiled test bot token (masked; not saved)'
  $discord = Invoke-RestMethod -Method Get -Uri 'https://discord.com/api/v10/users/@me' -Headers @{ Authorization = "Bot $discordToken" } -TimeoutSec 20
  $veiled = Invoke-RestMethod -Method Get -Uri 'https://api.veiled.lol/api/v1/bots/@me' -Headers @{ Authorization = "Bot $veiledToken" } -TimeoutSec 20
  $veiledUser = if ($veiled.user) { $veiled.user } else { $veiled }
  if (-not $discord.id -or -not $veiledUser.id) { throw 'An identity response was incomplete.' }
  if ([string]$discord.id -eq [string]$veiledUser.id) { throw 'The two test providers returned the same bot identity.' }
  Write-Output "Discord identity: $($discord.username) ($($discord.id))"
  Write-Output "Veiled identity: $($veiledUser.username) ($($veiledUser.id))"
  Write-Output 'Identity check passed. Only read-only identity endpoints were called; no messages, commands, or database were used.'
}
catch {
  Write-Error 'Bot identity check failed. No credential values were displayed or saved.'
  exit 1
}
finally {
  $discordToken = $null
  $veiledToken = $null
}