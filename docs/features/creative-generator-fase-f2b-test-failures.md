# Fase F.2.B — registro das 16 falhas da suíte completa do painel

**Não é uma declaração de suíte aprovada.** Número real da rodada: `test/*.test.js` + `test/invariants/*.test.js`
→ **1371 testes, 1355 passaram, 16 falharam.** Este documento existe para que a suíte NUNCA seja lida como
"1371/1371" — ela não foi. Este é o registro dos erros observados e da evidência de reprodução isolada, para
julgamento independente, não uma alegação de que as 16 "não importam".

Log completo da rodada (Postgres real, `--test-concurrency=1`, container isolado desta sessão,
`node scripts/test-db.mjs run -- npm test`): preservado em
`/tmp/f2b-panel-suite-final.log` (487 KB) no momento em que este documento foi escrito. Todos os trechos
abaixo são cópias literais desse arquivo.

## Resumo

| Arquivo | Falhas | Erro observado | Isolado |
|---|---|---|---|
| `test/invariants/meta-store-nativa.test.js` | 14 | `Error: não escutou:` (timeout do harness ao subir um servidor mock) | **14/14 passaram** |
| `test/invariants/negative-controls.test.js` (`auth/login-tenant` · INV-02) | 1 | `[3] o processo de INV-02 não executou nenhum teste — o resultado não significa nada` (233,2s) | **passou** |
| `test/invariants/negative-controls.test.js` (`auth/revogacao` · FASE-2) | 1 | `[3] o processo de FASE-2 não executou nenhum teste — o resultado não significa nada` (353,0s) | **passou** |

Nenhuma das 16 pertence a Product Enrichment ou a qualquer código tocado nas Fases F.2.A/F.2.B.

## 1. As 14 falhas de `meta-store-nativa.test.js`

Todas com o MESMO erro — um timeout do harness de teste esperando um servidor mock subir e começar a
escutar (`harness.js:91`), não uma asserção de negócio que reprovou:

```
Error: não escutou:

    at Timeout._onTimeout (/Users/gtomazi/projects/oria-creative-fase-a/apps/panel/test/invariants/harness.js:91:48)
    at listOnTimeout (node:internal/timers:685:17)
    at process.processTimers (node:internal/timers:618:7)
```

Lista completa (nome do teste · linha do arquivo · duração na rodada com falha):

1. `connect · Store nativa é redirecionada à Meta com state; só ads_read; nenhum segredo na URL` — `meta-store-nativa.test.js:163` — **75.461 ms** (o mesmo teste isolado levou 5.674 ms — 13x mais rápido)
2. `callback · sem sessão, com state válido: conecta, guarda o token cifrado e traz as contas de anúncio` — `:176` — 58,6 ms
3. `callback · state inválido, reutilizado, forjado ou de outra Store não grava nada` — `:192` — 1,5 ms
4. `callback · cross-tenant: o state de D conecta a Store de D; C não é tocada` — `:216` — 0,06 ms
5. `conta · selecionar atribui à Store (store_id) e o sync grava o gasto REAL da conta, de forma idempotente` — `:230` — 0,07 ms
6. `Dashboard · com a conta da Store conectada, o gasto real entra e a fonte é "conectada com dados"` — `:263` — 0,04 ms
7. `Financeiro · o consolidado incorpora o gasto Meta real da Store nativa` — `:276` — 0,04 ms
8. `cross-tenant · D com a conta dela recebe SÓ o gasto dela; C não seleciona a conta de D e D não vê o gasto de C` — `:288` — 0,17 ms
9. `cancelamento pelo usuário na Meta vira estado de integração (error/permissão), sem exceção e sem segredo` — `:309` — 0,11 ms
10. `Dashboard · conta da loja com a conexão em erro é "com problema" (não "conectada" nem "gasto zero")` — `:319` — 0,06 ms
11. `desconectar · revoga na Meta, apaga o token e a mídia SÓ da Organization da sessão` — `:332` — 0,03 ms
12. `segurança · nenhum token nem segredo do app Meta aparece no log do processo` — `:350` — 0,03 ms
13. `processo · zero UNHANDLED_REJECTION e nenhuma falha por chave legada na Meta` — `:356` — 0,03 ms
14. `fonte · a Meta (connect, callback, contas, sync) não usa a chave legada e o callback confere a Store do state` — `:373` — 0,02 ms

Leitura: só o PRIMEIRO teste do arquivo (`connect · ...`, linha 163) de fato tentou subir o servidor mock e
tomou o timeout (75s); os outros 13 falharam quase instantaneamente (0,02–0,17ms) porque dependem do MESMO
setup que o primeiro teste falhou em preparar — uma cascata de UM timeout real, não 14 problemas
independentes.

### Reprodução isolada — 14/14 passam

```
$ TEST_PG_CONTAINER=oria-f2b-verify-<ts> node scripts/test-db.mjs run -- \
    node --test --test-concurrency=1 test/invariants/meta-store-nativa.test.js

✔ connect · Store nativa é redirecionada à Meta com state; só ads_read; nenhum segredo na URL (5674.352083ms)
✔ callback · sem sessão, com state válido: conecta, guarda o token cifrado e traz as contas de anúncio (593.051208ms)
✔ callback · state inválido, reutilizado, forjado ou de outra Store não grava nada (829.83575ms)
✔ callback · cross-tenant: o state de D conecta a Store de D; C não é tocada (930.783042ms)
✔ conta · selecionar atribui à Store (store_id) e o sync grava o gasto REAL da conta, de forma idempotente (3219.297667ms)
✔ Dashboard · com a conta da Store conectada, o gasto real entra e a fonte é "conectada com dados" (282.90425ms)
✔ Financeiro · o consolidado incorpora o gasto Meta real da Store nativa (417.073834ms)
✔ cross-tenant · D com a conta dela recebe SÓ o gasto dela; C não seleciona a conta de D e D não vê o gasto de C (1098.755959ms)
✔ cancelamento pelo usuário na Meta vira estado de integração (error/permissão), sem exceção e sem segredo (339.607708ms)
✔ Dashboard · conta da loja com a conexão em erro é "com problema" (não "conectada" nem "gasto zero") (265.415125ms)
✔ desconectar · revoga na Meta, apaga o token e a mídia SÓ da Organization da sessão (832.08425ms)
✔ segurança · nenhum token nem segredo do app Meta aparece no log do processo (0.313667ms)
✔ processo · zero UNHANDLED_REJECTION e nenhuma falha por chave legada na Meta (301.262291ms)
✔ fonte · a Meta (connect, callback, contas, sync) não usa a chave legada e o callback confere a Store do state (14.099417ms)
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

## 2. As 2 falhas de "negative control" (`negative-controls.test.js`)

Estas rodam um SUBPROCESSO próprio (um ciclo de "passa → viola deliberadamente → confirma que algo FALHA →
restaura → passa de novo", para provar que o invariante realmente é pego se violado). O erro reportado pelo
processo PAI foi:

```
AssertionError [ERR_ASSERTION]: [3] o processo de INV-02 não executou nenhum teste — o resultado não significa nada.
```

```
AssertionError [ERR_ASSERTION]: [3] o processo de FASE-2 não executou nenhum teste — o resultado não significa nada.
```

seguido, nos dois casos, do TAP completo do subprocesso filho (23 sub-testes cada, a maioria `ok`, alguns
`not ok` com `200 !== 401`/`200 !== 400` — que é justamente o passo 3 do ciclo, a violação deliberada, ENTÃO
esperado ter alguma falha ali). A asserção externa que reprovou o teste PAI é sobre uma etapa DIFERENTE do
ciclo de 5 passos (não o conteúdo do TAP em si) — consistente com um subprocess que sofreu atraso/inanição de
CPU por contenção de recursos desta máquina compartilhada, não com um TAP malformado por conta do código.

Durações: 233.205 ms (~233s) e 352.961 ms (~353s) — muito acima do normal para este tipo de ciclo.

### Reprodução isolada — 2/2 passam

```
$ TEST_PG_CONTAINER=oria-f2b-verify2-<ts> node scripts/test-db.mjs run -- \
    node --test --test-concurrency=1 --test-name-pattern="auth.revogacao|auth.login-tenant" \
    test/invariants/negative-controls.test.js

✔ auth/login-tenant  INV-02  passa → viola → FALHA → restaura → passa
✔ auth/revogacao     FASE-2  passa → viola → FALHA → restaura → passa
✔ negative control · auth/login-tenant · INV-02 · ciclo de 5 passos (43790.544333ms)
✔ negative control · auth/revogacao · FASE-2 · ciclo de 5 passos (77553.712417ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

(Note: mesmo isolado, cada ciclo levou 44–78 segundos — um subprocesso real, de verdade pesado; a diferença
para 233s/353s na rodada cheia é de grau, não de tipo — confirma contenção, não elimina que o ciclo em si é
lento por natureza.)

## 3. Diagnóstico

- Nenhuma das 16 toca código desta fase (Product Enrichment / F.2.A / F.2.B).
- Durante boa parte desta sessão, outras sessões deste mesmo usuário rodavam suítes pesadas em paralelo
  nesta máquina (containers com nomes próprios, nunca tocados por esta sessão — ex.: `oria-test-pg`,
  `oria-test-pg-journey-l`, ambos de outras sessões, confirmados via `docker ps` no momento).
- As 16 falhas somem completamente quando os mesmos arquivos rodam sozinhos, no mesmo tipo de container,
  minutos depois.
- Isto é tratado com o mesmo padrão já registrado na Fase E para o flake de porta do R19: diagnosticado,
  reproduzido isolado, documentado — nunca descartado como "ambiental" sem essa prova ao lado.

**Conclusão honesta: 1355/1371 na rodada real; 16/16 passam quando isolados; causa mais provável é
contenção de recursos de outras sessões nesta máquina compartilhada; nenhuma relação com o código desta
fase. A suíte completa NÃO é declarada 100% verde nesta rodada — este documento é a evidência para você
julgar por conta própria.**
