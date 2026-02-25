Set WShell = CreateObject("WScript.Shell")
WShell.CurrentDirectory = "C:\Users\theas\AI\claude-launcher"
WShell.Run "cmd /c npm start", 0, False
