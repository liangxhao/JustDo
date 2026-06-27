chcp 65001 | Out-Null
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

npm run electron:dev:openclaw *>&1 | Out-File run_log.log -Encoding utf8


# powershell -ExecutionPolicy Bypass -File run_log.ps1