# Envio WhatsApp (app desktop)

App para macOS e Windows que executa a **fila de envio do WhatsApp Web** do painel (Integrações →
WhatsApp → modo WhatsApp Web). Plano completo em `../docs/plano-whatsapp-web-envio.md`.

O painel decide **o que** sai e **quando** (fila, janela de horário, limite recomendado, teto
diário, variações). O app só executa, uma mensagem por vez:

1. abre a conversa com o texto já preenchido
   - **WhatsApp Desktop**: `whatsapp://send?phone=…&text=…`
   - **WhatsApp Web**: `https://web.whatsapp.com/send?phone=…&text=…` no navegador padrão
2. espera carregar e confere que o WhatsApp (ou o navegador) está em primeiro plano
3. só com o computador parado, aperta **Enter** (no modo Web, fecha a aba depois)
4. informa o resultado ao painel e espera um intervalo aleatório

> Automatizar o WhatsApp não é oficial e pode levar ao bloqueio do número. Respeite o volume
> recomendado do painel e use variações de texto nas mensagens.

## Proteções

- **Só aperta Enter com o app certo na frente** — se você trocar de janela, ele não digita em
  outro programa (falha `app_nao_abriu`).
- **Só envia com o computador parado** (padrão: 10 s sem mouse/teclado). Se você mexer, ele espera;
  se não parar em 90 s, desiste da mensagem (`interrompido`).
- **Sempre abre pausado.** Nada sai sem clicar em "Iniciar envio".
- Pausa sozinho ao suspender ou bloquear a tela.
- Token guardado criptografado pelo cofre do sistema (Keychain / DPAPI).

Limitação: o app **não lê a tela**. "Enviada" significa que o Enter foi apertado com o WhatsApp em
primeiro plano — o painel mostra "Enviada (sem confirmação)". Número que não tem WhatsApp, por
exemplo, não é detectado.

## Uso

1. No painel: Integrações → WhatsApp → **WhatsApp Web** → **Gerar token do app**.
2. No app: cole a URL do painel e o token → **Salvar conexão**.
3. Escolha **WhatsApp Desktop** (app instalado e logado) ou **WhatsApp Web** (logado no navegador
   padrão; feche outras abas do WhatsApp Web para não aparecer "usar aqui").
4. **macOS**: libere o app em Ajustes → Privacidade e Segurança → **Acessibilidade** (o app pede
   na primeira vez). Na primeira tecla o macOS também pede permissão para controlar o
   "System Events".
5. **Testar** com o seu próprio número. Depois **Iniciar envio**.

Rodando pelo terminal (`npm start`), quem precisa de Acessibilidade é o **programa onde o terminal
está aberto** (Cursor, Terminal, iTerm…), não o app. Desligue essa permissão depois de testar.

Fechar a janela não para o envio: o app fica no ícone da barra (macOS) / bandeja (Windows).

## Desenvolvimento

```bash
cd desktop
npm install
npm test          # motor de envio, config e cliente do painel (sem Electron)
npm start         # abre o app
```

- `src/envio.js` — motor (sem Electron; tudo injetado, testável)
- `src/painel.js` — cliente HTTP (heartbeat, claim, resultado)
- `src/automacao/` — tecla e app em primeiro plano (`osascript` no macOS, PowerShell no Windows)
- `src/config.js` — configuração e token criptografado
- `src/main.js`, `src/preload.js`, `src/renderer/` — Electron (bandeja, janela, IPC)

Nenhum módulo nativo: não precisa recompilar nada ao atualizar o Electron.

## Gerar instaladores

```bash
npm run dist:mac   # dist/*.dmg (Apple Silicon e Intel) — rodar num Mac
npm run dist:win   # dist/*.exe (NSIS) — rodar no Windows (ou CI)
```

Sem assinatura por enquanto:

- **macOS**: depois de arrastar para Aplicativos, rodar uma vez
  `xattr -cr "/Applications/Envio WhatsApp.app"`. O app é assinado ad-hoc (sem Apple Developer):
  ao instalar uma versão nova, o macOS pode pedir a permissão de Acessibilidade de novo.
- **Windows**: o SmartScreen avisa; "Mais informações → Executar assim mesmo".

Assinar depois: Apple Developer (US$ 99/ano, com notarização) e certificado de código no Windows.

## A validar em máquina real

- Nome do processo do WhatsApp Desktop no Windows (a checagem aceita qualquer nome que contenha
  "whatsapp").
- Tempo de espera ideal para abrir a conversa (ajustável em "Ajustes avançados").
