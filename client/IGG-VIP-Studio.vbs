' Launches IGG VIP Studio with no console window.
' PyInstaller 6.x has no windowed bootloader for Python 3.14 yet, so the EXE
' itself is a console build; this hides that console for a clean desktop app.
Option Explicit
Dim fso, shell, here, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = here & "\IGG-VIP-Studio.exe"
If Not fso.FileExists(exePath) Then
  MsgBox "IGG-VIP-Studio.exe not found next to this launcher.", 16, "IGG VIP Studio"
  WScript.Quit 1
End If
' 0 = hidden window, False = do not wait
shell.Run """" & exePath & """", 0, False