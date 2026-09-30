# Landing pública premium (`oria.html`)

Rodada de redesign da página pública do Oria (`/` e `/oria`). Só a landing mudou: nenhuma rota, API,
banco, OAuth, fluxo autenticado ou tela do painel foi tocada. Sem deploy de produção.

## Auditoria (antes de escrever a copy)

- **Stack da landing:** HTML estático servido pela allowlist `lib/arquivos-publicos.js` — não passa pelo
  Vite/React. Por isso o movimento é CSS + `IntersectionObserver`, sem biblioteca (Motion/GSAP não se
  aplicam a esta página e não foram instalados; nenhuma skill externa instalada).
- **Restrição de verificação Google:** `/oria` é a página inicial cadastrada no console OAuth. Mantidos:
  nome "Oria" no início do H1, finalidade explicada, bloco "Google Analytics" com o texto já publicado
  (escopo `analytics.readonly`, Uso Limitado, link da política), operador e contato.
- **Funcionalidades confirmadas no código:** pedidos com status de pagamento e etapa da Reserva Ink;
  resultado financeiro com lucro e margem por período e por produto; Meta Ads (`ads_read`) e Google
  Ads só leitura; recuperação de carrinho e Pix pendente por WhatsApp (automática ou revisada),
  com checagem de compra ligada por padrão; 1 Organization = 1 Store.
- **Omitido por não estar pronto para clientes:** afiliados/parcerias (flag global desligada), estoque,
  relatórios de campanha, Instagram, hotpage Pix (marca ainda fixa), WhatsApp Web (não oficial).
- **Copy corrigida em relação à versão anterior:** "sempre somente leitura" deixou de valer para todas
  as integrações (a plataforma de vendas e o WhatsApp não são só leitura); "nunca envia para quem já
  comprou" virou "por padrão, não envia"; Oria mostra a etapa de produção, não gerencia a produção.
- **Canal comercial:** só existe o e-mail publicado (`tomazi.brand@gmail.com`); o CTA usa `mailto:`.

## Decisões

- Marca: símbolo oficial + wordmark recortado do logo oficial (`assets/oria/oria-wordmark.png`, sem
  alteração de forma ou cor). Menta de destaque amostrado do logo (`#3FE9C5`); o mockup usa os tokens
  do painel (`#35D07F` e semânticas) para parecer o produto.
- Mockups em HTML/CSS com dados fictícios e selo "Prévia ilustrativa".
- Vitrine em abas acessíveis (WAI-ARIA), sem pinning/scroll-jacking. Sem JS, os quatro painéis
  aparecem empilhados e o botão de menu some.
- Título e parágrafo do herói entram só com `transform` (sem opacidade zero) para não atrasar o LCP.

## QA

- Viewports 1440×900, 1920×1080, 768×1024, 390×844, 375×812, 360×780: sem overflow horizontal,
  um H1, sem erro de console. Reduced motion e sem JS conferidos.
- Teclado: link "Pular para o conteúdo", ordem de foco, abas com setas/Home/End, menu móvel com Esc.
- Links: `/admin`, `/politica-de-privacidade`, `/oria`, âncoras e assets respondem 200.
- Lab (Playwright + CDP, 390px, CPU 4×, ~1,6 Mbps/150 ms): LCP 0,7–1,3 s em 5 execuções (uma
  execução fria anterior deu 5,8 s por rede), CLS ≤ 0,007. Desktop: LCP ~1,1 s, CLS 0. Medida de
  laboratório, não de campo.
- `test/landing-oria.test.js` trava os invariantes da verificação Google; controle negativo feito
  (H1 com "O Oria" e escopo removido reprovam).

## Preview local

```bash
node -e "const e=require('express'),a=e();require('./lib/arquivos-publicos').montarArquivosPublicos(a,{raiz:process.cwd()});a.listen(4180)"
# em apps/panel; abrir http://localhost:4180/
```
