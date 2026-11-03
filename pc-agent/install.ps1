# JARVIS Agent — instalacja na Windowsie (laptop i gaming PC).
# 1) Zbuduj na laptopie:   dotnet publish -c Release
# 2) Skopiuj JarvisAgent.exe + ten skrypt na docelowy komputer (do jednego folderu)
# 3) PowerShell JAKO ADMINISTRATOR, w tym folderze:
#      powershell -ExecutionPolicy Bypass -File .\install.ps1 -Nazwa gaming
#    (na drugim komputerze -Nazwa laptop; ten sam -Token na obu, jeśli chcesz jeden AGENT_TOKEN w panelu)
param(
    [string]$Nazwa = $env:COMPUTERNAME,
    [string]$Token = "",
    [int]$Port = 8765,
    [string]$Cel = "C:\JarvisAgent"
)
$ErrorActionPreference = "Stop"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Uruchom PowerShell jako administrator." }

$exe = Join-Path $PSScriptRoot "JarvisAgent.exe"
if (-not (Test-Path $exe)) { throw "Brak JarvisAgent.exe obok skryptu (bin\Release\...\publish\JarvisAgent.exe)." }

New-Item -ItemType Directory -Force -Path $Cel | Out-Null
Stop-ScheduledTask -TaskName "JARVIS Agent" -ErrorAction SilentlyContinue
Get-Process JarvisAgent -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Copy-Item -Force $exe (Join-Path $Cel "JarvisAgent.exe")

# agent.json — tylko przy pierwszej instalacji (aktualizacja exe nie rusza tokena)
$cfgPath = Join-Path $Cel "agent.json"
if (-not (Test-Path $cfgPath)) {
    if (-not $Token) {
        $b = New-Object byte[] 24
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
        $Token = ($b | ForEach-Object { $_.ToString("x2") }) -join ""
    }
    [ordered]@{
        nazwa            = $Nazwa
        port             = $Port
        token            = $Token
        dozwoloneIp      = @("192.168.254.10", "100.105.181.54", "127.0.0.1", "::1")
        discordMikrofon  = "Ctrl+Shift+Alt+F9"
        discordSluchawki = "Ctrl+Shift+Alt+F11"
        pingHost         = "1.1.1.1"
    } | ConvertTo-Json | Set-Content -Encoding UTF8 $cfgPath
}
$Token = (Get-Content $cfgPath -Raw | ConvertFrom-Json).token

# Zapora: port agenta tylko z malinki (LAN + tailnet)
Remove-NetFirewallRule -DisplayName "JARVIS Agent" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "JARVIS Agent" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -RemoteAddress 192.168.254.10, 100.105.181.54 -Profile Any | Out-Null

# Autostart po zalogowaniu, z najwyższymi uprawnieniami (bez pytania UAC), restart przy awarii
$uzytkownik = "$env:USERDOMAIN\$env:USERNAME"
$akcja = New-ScheduledTaskAction -Execute (Join-Path $Cel "JarvisAgent.exe") -WorkingDirectory $Cel
$wyzwalacz = New-ScheduledTaskTrigger -AtLogOn -User $uzytkownik
$kto = New-ScheduledTaskPrincipal -UserId $uzytkownik -LogonType Interactive -RunLevel Highest
$ustawienia = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "JARVIS Agent" -Action $akcja -Trigger $wyzwalacz -Principal $kto -Settings $ustawienia -Force | Out-Null
Start-ScheduledTask -TaskName "JARVIS Agent"
Start-Sleep -Seconds 3

try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -Headers @{ "X-Agent-Token" = $Token } -TimeoutSec 10
    Write-Host "OK: agent '$($r.nazwa)' odpowiada na porcie $Port" -ForegroundColor Green
} catch {
    Write-Host "Agent nie odpowiada — sprawdź $Cel\agent.log" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Token do .env panelu (AGENT_TOKEN): $Token"
Write-Host "Discord: Ustawienia -> Skróty klawiszowe -> 'Przełącz wyciszenie' = Ctrl+Shift+Alt+F9, 'Przełącz ogłuszenie' = Ctrl+Shift+Alt+F11"
