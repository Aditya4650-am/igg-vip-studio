' Launches IGG VIP TOOL with no console window.
' The EXE is already a windowed build (--windows-console-mode=disable in
' protect/build.py), so this launcher is only a convenience for pinning it to
' the taskbar. Running IGG VIP TOOL.exe directly is equivalent.
Option Explicit
Dim fso, shell, here, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = here & "\IGG VIP TOOL.exe"
If Not fso.FileExists(exePath) Then
  MsgBox "IGG VIP TOOL.exe not found next to this launcher.", 16, "IGG VIP TOOL"
  WScript.Quit 1
End If
' 0 = hidden window, False = do not wait
shell.Run """" & exePath & """", 0, False