Set WshShell = CreateObject("Wscript.Shell")
WshShell.CurrentDirectory = "D:\ChatRoom"
WshShell.Run """C:\Program Files\nodejs\node.exe"" server.js", 0, True
