$ErrorActionPreference = 'Stop'

function Read-SecretText([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [IntPtr]::Zero
  try {
    if ($secure.Length -eq 0) { throw 'A required test credential was empty.' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secure.Dispose()
  }
}

$oldDiscord = $env:MIGRATION_DISCORD_TOKEN
$oldVeiled = $env:MIGRATION_VEILED_TOKEN
try {
  $env:MIGRATION_DISCORD_TOKEN = Read-SecretText 'Discord test bot token (masked; used only for this run)'
  $env:MIGRATION_VEILED_TOKEN = Read-SecretText 'Veiled test bot token (masked; used only for this run)'
  $env:MIGRATION_DISCORD_GUILD_ID = '1429510725927440600'
  $env:MIGRATION_DISCORD_CHANNEL_ID = '1435750382872822028'
  $env:MIGRATION_VEILED_ROOM_ID = 'c4x602a8oqzworj800k3mggcyx'
  $env:MIGRATION_VEILED_LANE_ID = 'cw7u7ieziq9bz0x6sm9quz8xkl'
  $smoke = Join-Path $PSScriptRoot 'migration-live-smoke.cjs'
  & node $smoke
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & node $smoke --send-and-delete
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  $env:MIGRATION_DISCORD_TOKEN = $oldDiscord
  $env:MIGRATION_VEILED_TOKEN = $oldVeiled
  $env:MIGRATION_DISCORD_GUILD_ID = $null
  $env:MIGRATION_DISCORD_CHANNEL_ID = $null
  $env:MIGRATION_VEILED_ROOM_ID = $null
  $env:MIGRATION_VEILED_LANE_ID = $null
}

