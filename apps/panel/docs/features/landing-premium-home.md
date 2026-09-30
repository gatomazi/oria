# Landing pública do Oria (`oria.html`) — V2 pós-auditoria

Redesign da página pública (`/` e `/oria`) a partir da auditoria de produto de 30/09/2026 e do briefing
"Oria Home V2". Só a landing mudou: nenhuma rota, API, banco, OAuth, fluxo autenticado ou tela do painel.
Sem deploy de produção.

## Matriz de promessas (o que a página afirma × evidência)

Estados: **PROD** = validado em produção por doc do repo; **IMPL** = implementado, sem smoke de produção;
**PARCIAL** = depende de configuração externa ou tem limite conhecido.

| Promessa na página | Implementação | Evidência | Estado | Copy autorizada |
|---|---|---|---|---|
| Resultado do período: faturamento → custo de produção → mídia → lucro após mídia + margem | Dashboard, Resultado do período | `src/pages/dashboard/DashboardPage.tsx:187-307`; checkpoint 21/09 §3 | PROD | Afirmativa, com os rótulos do painel |
| Custo de produção vem do pedido Ink | `lib/ink/financeiro.js` | idem | PROD | "Retido pela Reserva Ink" |
| Pedidos com etapa Ink, itens e rastreio | Pedidos central + drawer | `PedidosCentralPage.tsx`, `PedidoCentralDrawer.tsx`, `src/lib/statusMap.ts` | PROD (lista); drawer IMPL | "Etapa informada pela Reserva Ink"; sem Timeline (webhook desligado) |
| Loja real × Meta atribuído × GA4 atribuído | Meta Ads, GA4, Dashboard (páginas); comparação no consolidado | `lib/financeiro/consolidado.js:190-225` | Páginas PROD; comparação IMPL | "Mostra cada um com a origem dele"; sem MER/break-even |
| Meta/Google só leitura | escopo `ads_read`; GAQL SELECT | `server.js:10994`, `10425-10460` | PROD | "O Oria só lê / só consulta" (não "escopo somente leitura" para o Google) |
| Mapa de calor GA4 por horário | `MapaDeCalorGa4.tsx` | auditoria 28/09 #25 | PROD | Afirmativa |
| Lista única de clientes | Clientes | checkpoint §13 | PROD | Afirmativa |
| Segmentos RFM | `lib/clientes/rfm.js` | sem calibração real | IMPL | "Limites padrão, não calibrados para cada loja" |
| Catálogo: uma arte, várias cores; categorias em lote | `server.js:3226-3290`, `3685-4040` | escrita só em testes | IMPL | Seção "módulos opcionais", sem promessa de resultado |
| Criativos com IA, Feed/Story, BYOK | `routes/criativos.js`, `lib/creative-core/byok.js` | geração real não validada em produção | IMPL | "Sua própria chave OpenAI; custo na sua conta; estimativa no painel" |
| WhatsApp: central de recuperação | `/admin/recuperacao` (leitura) | checkpoint §3 | PROD (leitura) | "Reúne carrinhos e Pix pendentes, marca quem já comprou" |
| WhatsApp: envio pelo número da loja | Sender por tenant: painel → Go → Graph com credenciais da Organization (`server.js:12826-12866`; `services/whatsapp/identity.go`, `sender.go`) | nenhum envio entregue documentado no caminho multi-tenant; legado (mesmo código, antes da Fase 5b) enviou de verdade | PARCIAL | "Com o WhatsApp da loja conectado, você configura…"; "ativação junto com o nosso time" |

### WhatsApp — conta do dono × produto para lojista novo

- **Conta do dono:** falta de configuração (token de teste expirado, erro 130497 no número de teste — checkpoint 21/09). Não é bloqueio do produto.
- **Tech Provider:** necessário só para o Embedded Signup de terceiros. O cadastro manual com as credenciais da própria conta Meta do lojista envia sem ele. Status e respostas não chegam por esse caminho, porque o webhook valida o segredo do app da plataforma (`services/whatsapp/webhook.go:470-483`).
- **O que impede afirmar "recuperação automática" hoje** (defeitos de código, não da Meta):
  1. `modoEnvio` padrão `manual` (`server.js:12632`). Com a API Meta, o envio vai para `/queue/add` (`server.js:13127-13131`), e nenhuma tela libera essa fila; o texto de `AutomacoesPage.tsx:109-110` promete um dashboard que responde 410.
  2. Automações por evento não rodam em Store nativa: `if (!loja) return` em `server.js:644` (e `16828`).
  3. O follow-up automático de Pix usa `inkApiRequest(registro.loja, …)` (`server.js:15222`), que recusa Store nativa (`comTokenInk`, `server.js:501-507`).
- Por isso a página fala de **central de recuperação, conexão, modelos, cadência e segmentos**, sem "automático", "revisão antes do envio", "Pix automático" ou "tempo real". `test/landing-oria.test.js` trava esses termos.

## Storyboard (uma dor e uma demo por capítulo)

| # | Título | Demo |
|---|---|---|
| 01 | Sua loja vende. Você sabe quanto sobra? | Resultado do período com seletor 7/30/90 dias (contagem animada, barra de decomposição) |
| 02 | Faturamento não é lucro. | Cascata vertical; o passo em leitura acende o degrau |
| 03 | Do pagamento à entrega, sem perder o fio. | Lista de pedidos + gaveta com abas Resumo/Itens/Entrega |
| 04 | A mesma venda, três visões diferentes. | Abas Loja/Meta/GA4: comparativo, anúncios, mapa de calor |
| 05 | Conheça quem compra de você. | Lista de clientes ↔ mapa de segmentos (lista de barras no celular) |
| 06 | Menos trabalho repetido. | Arte em 4 cores (ciclo) e Feed 4:5 ↔ Story 9:16 |
| 07 | Recuperação e relacionamento, pelo número da sua loja. | Etapas de configuração + integrações + bloco Google |

A lista compacta de recursos fica só no fecho e não reconta as demos.

## Movimento

- Zero dependência: CSS + WAAPI-free, `IntersectionObserver` e `requestAnimationFrame`. Motion/GSAP e a skill `motion-react` foram avaliados e descartados (página estática sem build; o efeito cabe em CSS).
- **Nada nasce invisível.** A entrada parte de `opacity: .55` (nunca de 0) e só é aplicada a elementos que ainda vão entrar na tela. Cada bloco do script roda em `try/catch`.
- Sem JS: todos os painéis de abas ficam empilhados e visíveis; o botão de menu some e fica o link "Entrar".
- `prefers-reduced-motion` desliga animações, contagens e ciclos.

## QA

- Matriz Playwright local nos viewports 1440, 390, 375 e 360 px, sob 5 condições: padrão com rolagem, página inteira sem rolar, reduced motion, sem JS e erro injetado (`matchMedia` e `IntersectionObserver` quebrados).
  - 0 elemento essencial invisível, 0 overflow horizontal, 0 erro de página.
  - O único oculto no celular é o CTA compacto do topo, por desenho (o CTA está no menu e no herói).
- 1920 e 768 px sem overflow. Sem sobreposição entre o H1 e a demo de 1100 a 1920 px. Rótulos da cascata sem colisão em 360/390 px.
- Interações verificadas com mouse e teclado; vídeo gravado localmente.
- Lab mobile (CPU 4×, ~1,6 Mbps, 150 ms), 6 execuções: LCP 584–840 ms, CLS 0,0022. PR #51 media 0,7–1,3 s. HTML de ~21,5 KB com gzip, sem JS externo.

## Preview local

```bash
# em apps/panel
node -e "const e=require('express'),a=e();require('./lib/arquivos-publicos').montarArquivosPublicos(a,{raiz:process.cwd()});a.listen(4180)"
# abrir http://localhost:4180/
```

## Pendências fora do repositório

- Canonical/og continuam em `orgulhoregional.com.br/oria` (URL cadastrada no console OAuth do Google). Trocar de domínio exige atualizar o console junto.
- Contato comercial: o único canal publicado é `tomazi.brand@gmail.com`. Confirmar se continua sendo o canal de vendas.
- Correções de produto que destravariam a copy de "recuperação automática": os três defeitos de WhatsApp acima.
