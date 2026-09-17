'use strict';

const { execFile } = require('node:child_process');

// Windows: teclado via WScript.Shell e processo da janela em primeiro plano via user32. Scripts
// fixos, sem dado de cliente (o texto vai pela URL da conversa).
function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

const SCRIPT_PRIMEIRO_PLANO = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class JanelaAtiva {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$pid2 = 0
[void][JanelaAtiva]::GetWindowThreadProcessId([JanelaAtiva]::GetForegroundWindow(), [ref]$pid2)
(Get-Process -Id $pid2).ProcessName
`;

module.exports = {
  appEmPrimeiroPlano: () => powershell(SCRIPT_PRIMEIRO_PLANO),
  pressionarEnter: () => powershell("(New-Object -ComObject WScript.Shell).SendKeys('~')"),
  fecharAba: () => powershell("(New-Object -ComObject WScript.Shell).SendKeys('^w')"),
};
