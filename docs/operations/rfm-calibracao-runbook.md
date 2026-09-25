# Runbook · calibração da RFM na base real (somente leitura)

Uso: rodar **uma vez**, por quem tem acesso autorizado de leitura ao banco de produção (ou, melhor, a uma réplica de leitura).
Nada aqui altera dados, faz backfill, publica campanha ou mexe em infraestrutura. Status do acesso nesta sessão: **sem acesso
confirmado** (ver `docs/features/oria-clientes-rfm-fase0.md` §Rodada 3) — este runbook existe para a execução autorizada.

## 0. Pré-requisitos

- Node ≥ 20.11 e o repositório com a branch `feature/clientes-rfm` (`npm ci` em `apps/panel`).
- Um `DATABASE_URL` de **usuário somente leitura** (ideal: réplica). Pode ser o da role da aplicação (RLS) ou uma role de leitura
  com `SELECT` em `organizations`, `stores`, `pedidos_ink`, `pedidos_backfill_jobs`. **Não cole a URL em chat, ticket ou commit.**
- VPN/rede que alcance o banco, se aplicável.

## 1. Descobrir a Organization (sem nomes, sem segredo)

```bash
cd apps/panel
export DATABASE_URL='<url-somente-leitura>'          # exportada só neste terminal
node scripts/clientes/rfm-calibracao.mjs --listar-organizacoes --confirmo-host <host-do-banco>
```

Sem `--confirmo-host` o script **recusa** (fora de localhost) e mostra o host para você conferir. Saída: `uuid  stores=N  pedidos_ink=M`,
uma linha por Organization — o UUID da loja pretendida é o que tem o volume de pedidos esperado. Com RLS e a role da aplicação a
lista pode vir vazia: nesse caso use o UUID que você já conhece do Oria Admin.

## 2. Rodar o relatório (arquivos fora do Git)

```bash
mkdir -p relatorios-privados            # ignorado pelo Git (apps/panel/relatorios-privados/)
node scripts/clientes/rfm-calibracao.mjs \
  --organization <uuid-da-organization> --confirmo-host <host-do-banco> \
  --as-of "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --json relatorios-privados/calibracao-$(date +%F).json \
  --md   relatorios-privados/calibracao-$(date +%F).md
unset DATABASE_URL
```

O script aborta se: a sessão não estiver `READ ONLY`; o host não for confirmado; o caminho de saída estiver dentro do repositório
e não for ignorado; a Organization não tiver Store visível. Ele nunca imprime a URL, nem nome/e-mail/telefone/documento.

## 3. Conferências antes de qualquer decisão

Abra o `.md` e confira, **nesta ordem** (o restante só vale se estas passarem):

| # | Seção | Critério para seguir |
|---|---|---|
| 1 | §0 Cobertura | `backfillConfirmado = true` e `cobertura365Confirmada = true`. Se `false`, os números são do que foi **observado**, não da loja inteira: não calibrar limiares, só registrar. |
| 2 | §1 Integridade | `Linhas duplicadas` = 0 (ou pequeno e explicado); `Status NÃO reconhecidos` vazio (senão, mapear antes); `Sem identidade` baixo. |
| 3 | §1 **Pagamento válido com pedido encerrado** | Se > 0, decidir se `order_status ∈ {canceled, refunded, returned, …}` com pagamento `paid` deve sair da regra (hoje entra). Ver o cruzamento `pagamento × pedido`. |
| 4 | §2 Distribuições | `% de clientes de uma compra` e a concentração de receita; recência de quem tem 1 compra vs recorrentes. |
| 5 | §4 Recompra | Só usar janelas com `Elegível? = sim`; cada janela tem **denominador próprio** (não é curva cumulativa); `no mesmo dia` alto pode ser pedido dividido, não recompra. |
| 6 | §3 Estabilidade | % de clientes a ≤ 3 dias de um corte de recência e a ≤ 5% do corte de valor: alto = classificação instável naquele corte. |
| 7 | §5 Regra × alternativas | Mesma população e instante (`todasAlternativasNaMesmaPopulacaoEInstante = true`); olhar o impacto em **Campeões/Leais** e a receita por segmento. |
| 8 | §7 Conferências | As três somas (`segmentos = universo`, `receita = LTV`, `pedidos = válidos`) têm de ser `true`. |

### 3.1 As cinco decisões que o relatório real deve permitir (decidir em conjunto — nunca uma isolada)

| Decisão | Onde olhar no relatório | Sem dado real |
|---|---|---|
| (i) qualidade/alcance do backfill; `paid` + pedido encerrado | §0 Cobertura; §1 Integridade (cruzamento `pagamento × pedido`) | regra atual de `payment_status` mantida, limitações exibidas |
| (ii) reembolso parcial e limite do dado | §1 Integridade (`Reembolso parcial não é rastreado`) | não se inventa valor reembolsado |
| (iii) distribuição e intervalos reais de recompra | §2 Distribuições; §4 Recompra (só janelas com `Elegível? = sim`) | limiares 45/90/180/365 mantidos |
| (iv) soma × ticket médio para o corte de valor (comportamento de **Leais**) | §5 Regra atual × alternativas (impacto em Campeões/Leais) | `rfm-v1:c35267c2`, P75 da soma, opção A mantidos |
| (v) volume/carga que justifique snapshot persistido | §8 Volume e custo desta execução + latência real da tela de Clientes em produção | snapshots/job diário **não** implementados |

Sem acesso autorizado: **documentar o bloqueio e não alterar a regra**. O benchmark de 100 mil pedidos da Rodada 5 é sintético e não entra nesta decisão.

## 4. O que fazer com o resultado

- Guardar os arquivos onde o time de dados/produto combinar (nunca no repositório). Compartilhar só o `.md`/`.json` (agregados).
- Só depois: propor limiares com **números observados, janela, denominadores e critério** (nunca para equilibrar a matriz). Qualquer
  mudança de limiar muda `regraVersao`. Snapshots e job diário só depois dessa decisão.

## 5. Se algo falhar

| Sintoma | Causa provável |
|---|---|
| `Fora de localhost é preciso confirmar o host` | esperado: repita com `--confirmo-host <host>` |
| `a sessão não está em modo somente leitura` | o servidor ignorou `default_transaction_read_only`; use uma role/réplica de leitura |
| `a Organization não tem Store visível` | UUID errado, ou RLS sem permissão para a role usada |
| `recuso gravar … NÃO é ignorado pelo Git` | escreva em `apps/panel/relatorios-privados/` ou fora do repositório |

## 6. Checklist de acesso (o que o proprietário precisa providenciar — sem enviar credenciais)

- [ ] Réplica de leitura (ou role somente leitura) com `SELECT` em `organizations`, `stores`, `pedidos_ink`, `pedidos_backfill_jobs`.
- [ ] A `DATABASE_URL` dessa role, exportada **apenas no terminal de quem executa** (nunca em chat, ticket, commit ou log).
- [ ] O UUID da Organization da loja (o `--listar-organizacoes` ajuda a confirmar pelo volume de pedidos).
- [ ] Janela combinada e um destino para o `.md`/`.json` fora do Git (agregados; sem nome, e-mail, telefone ou documento).
- [ ] Confirmação de que nenhum backfill será iniciado por causa do relatório (o script é somente leitura).

CLI verificada na Rodada 5 contra o banco sintético local: `--listar-organizacoes`, `--organization`, `--store` (opcional), `--as-of`, `--json`, `--md` e `--confirmo-host` funcionam como descrito; fora de localhost e sem confirmação o script recusa **antes** de abrir qualquer conexão.
