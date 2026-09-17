'use strict';

const { execFile } = require('node:child_process');

// macOS: teclado e app em primeiro plano via System Events (AppleScript). Exige que o app tenha
// permissão de Acessibilidade (Ajustes → Privacidade e Segurança → Acessibilidade). Os scripts
// são fixos — nenhum dado de cliente entra aqui (o texto vai pela URL da conversa).
function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

module.exports = {
  appEmPrimeiroPlano: () => osascript('tell application "System Events" to get name of first application process whose frontmost is true'),
  pressionarEnter: () => osascript('tell application "System Events" to key code 36'),
  fecharAba: () => osascript('tell application "System Events" to keystroke "w" using command down'),
};
