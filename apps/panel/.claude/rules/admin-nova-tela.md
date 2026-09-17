---
paths:
  - "admin/src/**"
---

# Tela nova no admin

Antes de criar ou editar uma tela, formulário, modal, drawer ou feature em `admin/src/`, leia e
siga `docs/checklist-nova-tela.md`. Ela reúne o que foi aprendido na lapidação de UI em 9 fases
(13/09/2026) — cada item corrigiu um problema real já visto numa tela do painel. Pular a checklist
tende a reintroduzir um erro já corrigido (ordenação client-side numa lista paginada, `style={{}}`
solto, cor fora dos tokens, toast duplicado, animação sem saída, plural escrito "(s)").

Regra maior: a interface muda, o negócio não — nunca alterar rota, contrato de API, regra de
negócio ou texto de mensageria ao cliente pra resolver um item da checklist.
