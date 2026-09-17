# Briefing — Painel `/admin/dashboard` (Orgulho Regional × Reserva Ink)

## Contexto do produto
Site hub de descoberta de cidades/estampas (`orgulhoregional.com.br`) que direciona pra 3 lojas regionais na plataforma **Reserva Ink** (print-on-demand). Além disso tem um sistema interno de **pagamento PIX por pedido** e uma integração com a **API/webhook da Reserva Ink**, com um painel admin. Isso é o embrião de um produto maior (monitoramento de pedidos + recuperação de carrinho + futura automação via WhatsApp), mas por enquanto vive dentro desse mesmo site.

**Não é e-commerce completo, não é SaaS genérico.** É uma ferramenta interna (uso só do dono da loja), mas precisa manter a mesma identidade visual editorial/premium do site público — nada de visual "dashboard corporativo" ou glassmorphism genérico.

## Stack técnica (restrição importante)
- **Zero framework, zero build step.** HTML + CSS + JS puro (ES5, IIFE por arquivo, sem bundler).
- Backend: Node/Express, serve os HTML/CSS/JS estáticos diretamente.
- Layout deve funcionar em: 320, 375, 390, 430, 768, 1024, 1280, 1440, 1920px.
- Mobile é prioridade, mas desktop precisa ser desenho nativo (não mobile esticado).

## Identidade visual (tokens já usados no site inteiro)
```css
--paper:  #FFFBF3   /* fundo de card */
--cream:  #F8F1E5   /* fundo de página */
--sand:   #E8DCC4   /* fundo secundário / badges */
--ink:    #2D1810   /* texto principal, marrom escuro */
--ink-70 / --ink-50 / --ink-15 / --ink-10  /* variações de opacidade do ink */
--clay:       #4d543d  /* cor de destaque — varia por loja: sul=verde-oliva, centro=terracota (#8b5e3c), norte=verde-escuro (#2d4a2b) */
--clay-dark:  #363b29
--sucesso: #2d7a4e
--erro:    #b3402e

--r-sm: 6px; --r-md: 12px; --r-lg: 18px; --r-pill: 999px;
--sh-md: 0 4px 12px rgba(0,0,0,.08);

--font-display: 'Fraunces', Georgia, serif;   /* títulos — serifada editorial */
--font-sans: 'DM Sans', 'Inter', system-ui, sans-serif;  /* corpo */
```
Estética: papel/editorial, serifada nos títulos, cantos arredondados suaves, sombra leve, paleta terrosa (não é branco/azul corporativo).

## Páginas existentes relacionadas
| Rota | Arquivo | O que é |
|---|---|---|
| `/admin/pedidos` | `pedido-admin.html` + `src/pedido-admin.js/css` | Login + form de criar pedido manual (PIX colado à mão) + form de vincular pedido real da Reserva Ink por ID + lista de pedidos com status |
| `/admin/dashboard` | `dashboard.html` + `src/dashboard.js/css` | **← o que queremos melhorar** |
| `/{idpedido}` | `pedido.html` + `src/pedido.js/css` | Hotpage pública do cliente final (QR Pix, código copia-e-cola, status ao vivo) |

Login é compartilhado (cookie de sessão), então `/admin/dashboard` e `/admin/pedidos` devem parecer parte do mesmo sistema (mesma navegação, mesmo header).

## O painel hoje (`/admin/dashboard`) — funcional, mas cru
Estrutura atual (tudo em cards empilhados, sem grid pensado pra desktop):
1. **Header**: título + botão "Pedidos PIX" (navegação cruzada)
2. **Card "Pedidos · visão geral"**: 3 caixas de estatística lado a lado (Aguardando pagamento / Pagos / Problema-cancelado) — só número + label
3. **Card "Carrinhos abandonados"**: lista vertical simples (nome, loja, qtd itens, produto, data, badge "sem permissão de contato") com botão "Recuperar via WhatsApp" (abre `wa.me` com mensagem pré-pronta)
4. **Card "Últimos pedidos"**: tabela HTML crua (Loja / Cliente / Valor / Status / Data / ação "Vincular" ou "Copiar link")

**O que está faltando / pontos fracos pra melhorar:**
- Sem hierarquia visual forte entre os 3 blocos — tudo parece igual em peso
- Tabela de pedidos não tem estados vazios bonitos, nem paginação, nem filtro
- Sem gráfico/visualização nenhuma (só números crus)
- Carrinhos abandonados e pedidos competem por atenção — não fica claro qual é a ação prioritária do dia
- Não tem indicação clara de "loja" com cor/bandeira visual (cada loja tem uma cor própria: sul=verde-oliva, centro=terracota, norte=verde-escuro — isso não é usado no dashboard ainda)
- Mobile: os cards empilham ok, mas a tabela de pedidos vai ter overflow horizontal — precisa virar cards/lista no mobile em vez de tabela

## Dados reais disponíveis (contrato das APIs — já prontos, não mudar)

**`GET /api/admin/dashboard/orders`** (autenticado via cookie):
```json
{
  "pedidos": [
    { "loja": "sul", "inkOrderId": 123, "createdAt": "2026-09-01T12:00:00Z",
      "cliente": "Maria Silva", "valor": "149.90",
      "orderStatus": "paid", "orderStatusLabel": "Pago",
      "paymentStatus": "paid", "hotpageId": "abc123xyz789" }
  ],
  "resumo": { "aguardando": 3, "pago": 12, "problema": 1, "total": 16 },
  "erros": [{ "loja": "norte", "error": "..." }]
}
```
(`hotpageId` é `null` quando o pedido ainda não tem link gerado — aí a ação é "Vincular" em vez de "Copiar link")

**`GET /api/admin/dashboard/abandoned-carts`**:
```json
{
  "carrinhos": [
    { "loja": "centro", "id": 55, "updatedAt": "2026-09-01T10:00:00Z",
      "itemsCount": 2, "contactable": true,
      "buyerName": "João Souza", "buyerPhone": "5548999998888",
      "primeiroProduto": "Camiseta Curitiba" }
  ],
  "erros": []
}
```
(`contactable: false` = não pode contatar por marketing, esconder ação de WhatsApp nesse caso)

`erros` (em ambos) é uma lista de `{loja, error}` quando alguma das 3 lojas falhou ao consultar — precisa de um jeito discreto de mostrar isso sem quebrar o resto do painel.

## O que eu preciso da IA que vai desenhar o layout
- Redesenhar a organização visual/hierarquia do `/admin/dashboard` usando os dados acima, mantendo a identidade (tokens de cor/fonte informados)
- Pensar em: o que é a ação mais importante do dia (provavelmente carrinho abandonado quente + pedido com problema) deveria ganhar destaque
- Usar a cor de cada loja pra diferenciar visualmente (sul/centro/norte) sem virar poluição visual
- Desktop: aproveitar layout em colunas/grid; mobile: virar lista/cards em vez de tabela
- Pode propor pequenos elementos de dado (barra de progresso, mini gráfico de status) desde que sejam simples de implementar em CSS/JS puro (sem lib de gráfico pesada)
- Manter tudo implementável em HTML/CSS/JS vanilla, sem framework
