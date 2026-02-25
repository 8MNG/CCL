\ = New-Object -ComObject WScript.Shell
\ = [Environment]::GetFolderPath("Desktop")
\ = \.CreateShortcut(\ + "\Claude Launcher.lnk")
\.TargetPath = "wscript.exe"
\.Arguments = """C:\Users\theas\AI\claude-launcher\launch.vbs"""
\.WorkingDirectory = "C:\Users\theas\AI\claude-launcher"
\.Description = "Claude Code Launcher"
\.Save()
\ = \:APPDATA + "\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
if (-not (Test-Path \)) { New-Item -ItemType Directory -Path \ | Out-Null }
Copy-Item (\ + "\Claude Launcher.lnk") (\ + "\Claude Launcher.lnk") -Force
Write-Host done