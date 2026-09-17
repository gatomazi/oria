# BRIEFING — Loja de Personalizados (/loja)

Sub-produto do `orgulhoregional` para vender camisetas personalizadas via WhatsApp, com preview em tempo real. **Não substitui** a busca de cidade → Reserva Ink que já existe — é um caminho paralelo pro que a Ink não permite personalizar.

Última atualização: 03/jul/2026.

---

## 1. CONTEXTO E OBJETIVO

### Problema
Reserva Ink não permite personalização em tempo de compra. Nada de nomes, datas, escolhas de cliente. Perdemos janela em datas comemorativas (Dia dos Pais, Dia das Mães, Copa, Namorados) e presentes com nome.

### Solução
Sub-loja **`/loja`** dentro do `orgulhoregional`, com 3 modelos personalizáveis, preview visual em tempo real, e checkout via WhatsApp — a produção continua sob demanda mas fora do fluxo Ink (a estamparia é local ou parceira artesanal).

### Restrições
- **Cliente edita SÓ o texto.** Fonte, posição, cor da estampa, tamanho — tudo pré-definido pelo modelo.
- **Sem carrinho, sem checkout no site.** Botão final gera mensagem estruturada e abre WhatsApp.
- **Mobile-first.** Meta Ads + Instagram entregam quase todo o tráfego.
- **Uma loja por região** (`/sul/loja`, `/centro/loja`, `/norte/loja`) — mesma UI, sugestões regionais próprias, mesmo WhatsApp.

---

## 2. STACK

Igual à do `orgulhoregional`. Sem build step.

- Express 4 (`server.js`)
- HTML/CSS/JS puro (SPA client-side)
- Fontes Google (Fraunces + DM Sans) via `<link>`
- 2 fontes custom (self-hosted): Handelson e Montserrat Black em `assets/fonts/`
- Deploy: Railway (mesmo do `orgulhoregional`)

---

## 3. ROTAS

Todas atendidas pelo `server.js`:

```
GET  /{sul|centro|norte}/loja                                     → loja.html (SPA)
GET  /{sul|centro|norte}/loja/produto/{slug}                      → loja.html (mesma SPA, roteador client)
POST /api/loja/log                                                → log de eventos (opcional)
```

O `loja.html` é uma única página que detecta a região via `window.location.pathname`, troca o tema (cor `--clay`), popula sugestões regionais e roteia entre home ↔ produto.

---

## 4. ESTRUTURA DE ARQUIVOS

```
orgulhoregional/
├── server.js                          (adicionadas rotas /loja + endpoint de log)
├── loja.html                          NOVO — SPA da loja
├── src/
│   ├── loja.css                       NOVO — design system (paleta editorial + clay regional)
│   └── loja.js                        NOVO — roteamento, render, WhatsApp, SVG preview
├── data/
│   ├── config.json                    NOVO — WhatsApp, preços por região, campanha ativa
│   └── produtos.json                  NOVO — catálogo, modelos, cores, tamanhos, categorias
├── assets/
│   ├── fonts/
│   │   ├── handelson-six.otf          fonte manuscrita (Palavras Coloridas)
│   │   └── Montserrat-Black.ttf       fonte bold (Regionalismo Minimal)
│   ├── mockups/                       fotos de camiseta lisa (fallback)
│   │   └── camiseta-{cor}.png         (9 arquivos — uma por cor)
│   ├── mockups-brasao/                mockups FINALIZADOS (foto + brasão aplicado)
│   │   └── camiseta-{cor}-{relacao}.jpg  (9 cores × 2 relações = 18 arquivos)
│   └── brasoes/                       brasões sozinhos + dígitos do ano
│       ├── brasao-pai.png
│       ├── brasao-avo.png
│       └── numero-{0..9}.png          (10 dígitos)
├── scripts/
│   └── verificar-mockups.js           audita quais assets estão presentes
└── docs/
    └── loja-personalizados-briefing.md   este arquivo
```

---

## 5. MODELO DE DADOS

### `data/config.json`
```json
{
  "whatsapp": { "number": "5548999999999" },
  "precos": {
    "sul":    { "base": 119.90, "personalizado": 139.90, "premium": 169.90 },
    "centro": { "base":  99.90, "personalizado": 119.90, "premium": 149.90 },
    "norte":  { "base": 119.90, "personalizado": 139.90, "premium": 169.90 }
  },
  "freteGratis": { "acima": 199.90 },
  "campanhaAtiva": {
    "slug": "dia-dos-pais",
    "titulo": "Dia dos Pais 2026",
    "vigenciaFim": "2026-08-10",
    "urgencia": "Últimos dias — produção sob demanda em até 7 dias úteis"
  }
}
```

### `data/produtos.json`
- `categorias[]` — Dia dos Pais, Presentes, Regionalismo, Família, Namorados, Copa
- `cores[]` — 9 cores (Preta, Branca, Bordô, Azul marinho, Mescla cinza, Vermelha, Verde musgo, Amarelo mostarda, Rosê) com `hex`, `estampaClara` e `mockup`
- `tamanhos.adulto` — P/M/G/GG/XGG
- `modelos[]` — array com os 3 modelos (Emblema, Palavras Coloridas, Regionalismo Minimal)

---

## 6. OS 3 MODELOS

### 6.1 — Emblema Raízes
- **Slug:** `emblema-raizes`
- **Assinatura fixa:** "RAÍZES QUE ENSINAM" (arco topo) / "LEGADO QUE FICA" (arco base)
- **Cliente edita:**
  - `relacao` (select) — **PAI** ou **AVÔ**
  - `ano` (number) — 1930-2025, padrão 1970
- **Visual:**
  - Modo **Camiseta**: mostra o mockup finalizado `mockups-brasao/camiseta-{cor}-{relacao}.jpg` (foto real da camiseta com brasão já estampado)
  - Modo **Closeup** (auto-ativa no 1º edit): brasão sozinho `brasoes/brasao-{relacao}.png` + dígitos do ano `brasoes/numero-{d}.png` sobrepostos na posição das raízes
- **Fallback**: se algum PNG faltar, renderiza SVG dinâmico (função `svgEmblema` em `loja.js`)

### 6.2 — Palavras Coloridas
- **Slug:** `palavras-coloridas`
- **Cliente edita:** até 6 linhas de texto livre (4 obrigatórias + 2 opcionais). MaxLength 12-18 chars por linha.
- **Estampa:**
  - Fonte **Handelson** (self-hosted)
  - Paleta **fixa** com 6 cores oficiais: laranja `#d46a3a`, dourado `#c9a33a`, verde-azulado `#2f6f68`, cinza `#9a9a9a`, azul `#026495`, bege `#d6c1a3`
  - Cores rotacionam por linha
- **Sugestões regionais no placeholder**: gentílicos (PARANAENSE, GOIANO, AMAZONENSE...), papéis (MARIDO, PAI, IRMÃO...), hobbies, adjetivos

### 6.3 — Regionalismo Minimal
- **Slug:** `regionalismo-minimal`
- **Cliente edita:** 1 expressão (max 16 chars)
- **Fonte:** Montserrat Black (self-hosted)
- **Sugestões regionais**: piazinho./guri./bah. (sul), uai./sô./trem bão. (centro), égua./mermão./curumim. (norte)

---

## 7. FLUXO DO PRODUTO

### 7.1 UX
1. Usuário abre `/{regiao}/loja` → home com hero da campanha + grid de modelos
2. Toca em modelo → `/{regiao}/loja/produto/{slug}` (roteamento client-side, sem reload)
3. Painel de personalização à direita (mobile: abaixo do preview)
4. Preview atualiza em tempo real conforme edita
5. Marca checkbox "Confirmo dados corretos" → botão WhatsApp libera
6. Modal com resumo → botão abre `wa.me/{numero}?text=...` com mensagem estruturada

### 7.2 Modos de visualização
- **Camiseta** (default): foto pronta do mockup finalizado quando existe; caso contrário, foto de camiseta lisa + estampa SVG sobreposta
- **Closeup**: brasão/estampa grande em fundo escuro
- **Auto-switch pro closeup** na primeira edição de qualquer campo

### 7.3 Regras de personalização
- **Sem escolha de fonte, posição, tamanho da estampa, cor da estampa**
- **Áreas limitadas** por `maxLength` em cada input
- SVG ajusta tamanho da fonte automaticamente pra caber
- Fonte específica por modelo é imutável

---

## 8. CHECKOUT VIA WHATSAPP

### Mensagem gerada (exemplo)
```
Olá! Quero encomendar essa personalização da Use Sul.

🛒 *Emblema Raízes*
   Raízes que ensinam, legado que fica

✍️ *Personalização:*
   • Relação: PAI
   • Ano de nascimento: 1984

👕 Cor: Preta  |  Tamanho: G  |  Qtd: 1
💰 Total: R$ 139,90

📍 Endereço pra envio:
_(preencher aqui: nome, rua, número, bairro, cidade/UF, CEP)_

💳 Forma de pagamento preferida: PIX / cartão / boleto
```

URL gerada: `https://wa.me/{numero}?text={mensagem-URL-encoded}` — abre WhatsApp Web/mobile com tudo pronto, cliente só precisa preencher endereço e mandar.

---

## 9. DESIGN SYSTEM

Reaproveitado do `~/projects/estamparia` — mais editorial e sofisticado que catálogo genérico.

### Paleta
- `--paper: #FFFBF3` (cards)
- `--cream: #F8F1E5` (bg da página)
- `--sand: #E8DCC4` (acento suave)
- `--ink: #2D1810` (texto principal)
- `--clay` (destaque, TROCA POR REGIÃO):
  - Sul: `#4d543d` (verde-oliva)
  - Centro: `#8b5e3c` (terracota)
  - Norte: `#2d4a2b` (verde-amazônia)

### Tipografia
- **Fraunces** (display serif com italic) — títulos, preços, quotes
- **DM Sans** (sans body) — corpo, UI, botões
- Cargas custom pra estampa: **Handelson** e **Montserrat Black**

### Componentes
- Cards com aspect-ratio 4/5, hover translateY(-3px) + shadow, border-color clay
- Chips pill (7-8px de padding, borda 1.5px, ativo 2px + bg clay-bg + color clay)
- Botão primary rounded pill com hover boxshadow
- Grid detail 2 colunas (`1.1fr | 0.9fr`) → 1 col no mobile
- Grain background sutil (radial-gradient de pontos)
- Skeleton shimmer bar pra loading (herança do estamparia)

---

## 10. ASSETS OBRIGATÓRIOS

Roda `node scripts/verificar-mockups.js` pra ver o que falta. Resumo do que precisa:

| Pasta | Tipo | Qtd | Nome |
|---|---|---|---|
| `assets/fonts/` | fonte | 2 | `handelson-six.otf`, `Montserrat-Black.ttf` |
| `assets/mockups/` | PNG camiseta lisa | 9 | `camiseta-{cor}.png` |
| `assets/mockups-brasao/` | JPG camiseta + brasão | 18 | `camiseta-{cor}-{pai|avo}.jpg` |
| `assets/brasoes/` | PNG brasão sozinho | 2 | `brasao-pai.png`, `brasao-avo.png` |
| `assets/brasoes/` | PNG dígitos | 10 | `numero-0.png` … `numero-9.png` |

**Fallbacks em cascata** — o site nunca "quebra" visualmente:
1. Mockup finalizado falta → mostra camiseta lisa + estampa SVG sobreposta
2. Camiseta lisa falta → retângulo colorido com hex da cor
3. Brasão PNG falta → SVG dinâmico do brasão
4. Dígito falta → dígito invisível (ainda mostra o brasão)

---

## 11. PREÇOS

Placeholders em `config.json`. Defina antes de subir. Sugestão inicial:

| Região | Regular | Personalizado | Premium (algodão peruano) |
|---|---|---|---|
| Sul | R$ 119,90 | R$ 139,90 | R$ 169,90 |
| Centro | R$ 99,90 | R$ 119,90 | R$ 149,90 |
| Norte | R$ 119,90 | R$ 139,90 | R$ 169,90 |

Preço mostrado no produto é sempre `personalizado`. Ajuste de kit progressivo NÃO faz sentido aqui (produto sob demanda, sem margem pra desconto por volume).

---

## 12. WHATSAPP

Um número único pra 3 lojas. Configurado em `data/config.json`:

```json
{ "whatsapp": { "number": "5548999999999" } }
```

Substituir por número real no formato E.164 sem `+` (ex: `5548991234567` pra `+55 48 99123-4567`) antes de subir.

---

## 13. COMO RODAR LOCAL

```bash
cd /Users/gtomazi/projects/orgulhoregional
npm start
```

Abrir:
- Home Sul: http://localhost:8080/sul/loja
- Home Centro: http://localhost:8080/centro/loja
- Home Norte: http://localhost:8080/norte/loja
- Produto: http://localhost:8080/sul/loja/produto/emblema-raizes

Validar assets:
```bash
node scripts/verificar-mockups.js
```

---

## 14. PENDENTES ANTES DE SUBIR PRODUÇÃO

- [ ] Preencher `whatsapp.number` real em `data/config.json`
- [ ] Ajustar preços em `data/config.json` (hoje placeholder)
- [ ] Definir vigência real da campanha em `data/config.json`
- [ ] Gerar e salvar 18 mockups finalizados em `assets/mockups-brasao/`
- [ ] Gerar e salvar `brasao-pai.png` e `brasao-avo.png` em `assets/brasoes/` (fundo transparente)
- [ ] Gerar e salvar 10 dígitos (`numero-0.png` a `numero-9.png`) em `assets/brasoes/`
- [ ] Rodar `node scripts/verificar-mockups.js` — objetivo: 0 faltando
- [ ] Configurar produção do artesão parceiro (fluxo interno)
- [ ] Definir template padrão de resposta pro WhatsApp com dados bancários / PIX
- [ ] Testar checkout em mobile real (iOS + Android, WhatsApp app)
- [ ] Publicar link no perfil dos 3 Instagrams

---

## 15. FUTURO (não pro MVP)

- Adicionar novos modelos (ex: "De onde vim" com mini-mapa dos dois estados; presente com nome específico "Vovô do Pedro")
- Ampliar relações do emblema pra MÃE, AVÓ, PADRINHO, MADRINHA, TIO, TIA, IRMÃO, IRMÃ, FILHO, FILHA (mapa de slug já preparado em `loja.js`)
- Adicionar página de campanhas específicas (Dia das Mães, Namorados, Copa)
- Integrar Meta Pixel + eventos de conversão (add_to_cart, purchase quando WhatsApp confirmar)
- Adicionar tabela de medidas real por camiseta
- Painel admin simples pra gerenciar pedidos vindos do WhatsApp
