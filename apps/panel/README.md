# Painel do Oria (`oria-panel`)

Serviço Node único: a API do produto, o SPA do painel (React + Vite) e as poucas páginas que o
produto serve abertas. **Um deployable, um `package.json`, um lockfile.**

Este diretório nasceu do repositório do site da Orgulho Regional, que foi reaproveitado para
construir o painel. O site em si (busca de cidade, páginas regionais, loja de personalizados) saiu
daqui; o que sobrou é o produto.

## Layout

```text
apps/panel/
├── index.html          shell do SPA (template do Vite, NÃO é servido por URL)
├── src/                frontend React/TS do painel + o CSS/JS da hotpage de pagamento
├── vite.config.mjs     build do SPA (base de URL `/admin/`, saída em `dist/`)
├── dist/               build do SPA (gerado, fora do git)
│
├── server.js           backend/API — CommonJS, e continua CommonJS
├── lib/ routes/ migrations/ scripts/ test/
├── oria.html  politica-de-privacidade.html  pedido.html
└── package.json  package-lock.json
```

O frontend já morou em `apps/panel/admin/`, com manifesto, lockfile e build próprios. Subiu para a
raiz: era um segundo app dentro do deployable, e a pasta `admin/` se confundia com a URL `/admin`,
que é outra coisa. A pasta acabou; a URL não mudou. `scripts/repo-self-check.mjs`, na raiz do
monorepo, reprova se `apps/panel/admin/` voltar a existir.

## O que responde sem autenticação

| rota | o que é |
|---|---|
| `/` e `/oria` | landing do Oria (`oria.html`) — `/oria` é a página inicial do app cadastrada no console de OAuth do Google |
| `/politica-de-privacidade` | a outra URL cadastrada no console do Google |
| `/hotpix/{id}` | hotpage de pagamento Pix do pedido; o link vai pro cliente por WhatsApp |
| `/admin/*` | SPA do painel (build do Vite em `dist/`) — a tela de login é a porta |

A allowlist do que sai do disco está em [`lib/arquivos-publicos.js`](lib/arquivos-publicos.js), e o
que ela recusa está travado em [`test/arquivos-publicos.test.js`](test/arquivos-publicos.test.js).
`src/` **não** é um diretório público: guarda o código-fonte do painel, e só os dois arquivos da
hotpage (`src/pedido.css`, `src/pedido.js`) são nomeados como públicos.

## Rodar

```bash
npm ci
npm run build       # tsc -b && vite build → dist/
npm run migrate:up
npm start           # node server.js
```

Durante o desenvolvimento do frontend, `npm run dev` sobe o Vite com proxy de `/api` para o
`server.js` local (porta 8080).

## Testes

```bash
npm test          # suíte + invariants (sobe Postgres efêmero no Docker)
npm run build     # build do SPA do painel
```

Nenhum teste se pula em silêncio. Detalhes de ambiente e de operação no
[README do monorepo](../../README.md) e em `docs/`.
