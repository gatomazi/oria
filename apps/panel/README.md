# Painel do Oria (`oria-panel`)

Serviço Node único: a API do produto, o SPA do painel (`admin/`, React + Vite) e as poucas páginas
que o produto serve abertas.

Este diretório nasceu do repositório do site da Orgulho Regional, que foi reaproveitado para
construir o painel. O site em si (busca de cidade, páginas regionais, loja de personalizados) saiu
daqui; o que sobrou é o produto.

## O que responde sem autenticação

| rota | o que é |
|---|---|
| `/` e `/oria` | landing do Oria (`oria.html`) — `/oria` é a página inicial do app cadastrada no console de OAuth do Google |
| `/politica-de-privacidade` | a outra URL cadastrada no console do Google |
| `/{idpedido}` | hotpage de pagamento Pix do pedido; o link vai pro cliente por WhatsApp |
| `/admin/*` | SPA do painel (build do Vite em `admin/dist`) — a tela de login é a porta |

A allowlist do que sai do disco está em [`lib/arquivos-publicos.js`](lib/arquivos-publicos.js), e o
que ela recusa está travado em [`test/arquivos-publicos.test.js`](test/arquivos-publicos.test.js).

## Rodar

```bash
npm ci            # postinstall builda o admin (admin/dist)
npm run migrate:up
npm start
```

## Testes

```bash
npm test          # suíte + invariants (sobe Postgres efêmero no Docker)
npm run build     # build do SPA do painel
```

Nenhum teste se pula em silêncio. Detalhes de ambiente e de operação no
[README do monorepo](../../README.md) e em `docs/`.
