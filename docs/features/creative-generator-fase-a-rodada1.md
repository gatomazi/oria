# Creative Generator V2 — Fase A · fechamento da Rodada 1 do A/B

Encerrada em 2026-09-21. **A Rodada 2 não foi executada** e, com o resultado abaixo, não há sinal que justifique mais 40 gerações só para investigar anatomia.

## Conclusão

> A regressão de anatomia observada anteriormente **não se reproduziu** nesta Rodada 1 após a instrumentação e os ajustes da Fase A.

Isto é o resultado deste experimento, não prova estatística de que o problema foi eliminado. Com `n=4` por braço e ângulo, este relatório **não** declara vencedor entre os braços.

## Avaliação humana (cega, feita antes de abrir o manifest)

- 40 imagens avaliadas. Nenhum dedo extra, nenhuma mão claramente incorreta, nenhum problema anatômico aparente.
- Qualidade geral boa.
- Achados qualitativos (viraram requisitos da Fase B, ver `creative-generator-fase-b.md`): vestuário infantil (pernas), direção do olhar (~85% fora da câmera) e coerência semântica produto × composição (estampa "Pai" sugerindo "Mãe").

## Execução

| | |
|---|---|
| Gerações | 40 chamadas, 0 falhas, 0 retries; nenhuma outra chamada à OpenAI |
| Modelo | 40/40 servidas por `gpt-image-2` (= pedido), sem fallback, sem contaminação |
| Parâmetros | `quality=medium`, `size=1088x1360` → 1080×1350, iguais nas 40 |
| Referência | uma só (`brincar com meu pai pipa - menina.webp`, 800×820, 180.648 B, sha256 `9fcb86f1…`), a mesma nas 5 pontas |
| Uso / custo | 91.632 tokens de entrada, 63.480 de saída; **US$ 2,485 estimado** pela tabela do Oria (a fatura da OpenAI é o número real). Sem tokens em cache reportados |

## Braços — confirmação técnica (a partir dos traces)

| Braço | Prompt | Referência enviada | Confirmado |
|---|---|---|---|
| A | Streamlit | PNG normalizado (`image/png`, 303.287 B) | prompt = texto Streamlit, `normalized=true` |
| B | Oria V1 | bytes originais (WebP anunciado como `image/png`, 180.648 B) | `prompt_version=1`, `normalized=false` |
| C | Oria V1 | PNG normalizado | prompt idêntico ao de B em todo ângulo/seed (mesmo sha256) |
| D | Streamlit | bytes originais | prompt idêntico ao de A |
| E | Oria V2 | PNG normalizado | `prompt_version=2`, prompt diferente de B/C |

Nas 16 gerações com o caminho legado a API aceitou o WebP anunciado como PNG. O provedor contou 1.024 tokens de imagem tanto para o original quanto para o normalizado.

### Mapa IMG → braço

| Braço | Ângulo | Imagens |
|---|---|---|
| A | CAIMENTO | IMG-007, IMG-017, IMG-027, IMG-028 |
| A | PRESENTE_AFETO | IMG-012, IMG-020, IMG-031, IMG-033 |
| B | CAIMENTO | IMG-003, IMG-004, IMG-030, IMG-037 |
| B | PRESENTE_AFETO | IMG-014, IMG-023, IMG-035, IMG-039 |
| C | CAIMENTO | IMG-002, IMG-009, IMG-026, IMG-036 |
| C | PRESENTE_AFETO | IMG-005, IMG-006, IMG-015, IMG-016 |
| D | CAIMENTO | IMG-019, IMG-025, IMG-029, IMG-040 |
| D | PRESENTE_AFETO | IMG-001, IMG-013, IMG-018, IMG-034 |
| E | CAIMENTO | IMG-008, IMG-022, IMG-024, IMG-038 |
| E | PRESENTE_AFETO | IMG-010, IMG-011, IMG-021, IMG-032 |

### As três imagens citadas

| Imagem | Braço | Ângulo | Seed |
|---|---|---|---|
| IMG-009 | **C** — Oria V1 + PNG normalizado | CAIMENTO | 104 |
| IMG-018 | **D** — prompt Streamlit + bytes originais | PRESENTE_AFETO | 103 |
| IMG-037 | **B** — Oria V1 + bytes originais | CAIMENTO | 104 |

São três braços diferentes; nenhuma é do braço E (V2) nem do A. Duas são CAIMENTO V1 (B e C), que têm o **mesmo prompt** e diferem só na normalização. Com três imagens não dá para inferir relação com o braço gerador, e a avaliação não sugere uma.

## Limites do desenho (para não superinterpretar)

- Persona só com `label` (sem `behavior`): o filtro persona × ângulo do commit `c6f2f0f` não foi exercido.
- As sementes do V2 forçaram, no presente, o cenário "criança veste / mãe neutra"; V1 e Streamlit escolhem livremente entre entregar e vestir.
- O prompt Streamlit foi fixo por ângulo. O template CAIMENTO da Entre Nós do Streamlit não tem as regras de braços do template regional (que o V2 portou).
- As pontas Oria usaram um Brand Kit da Entre Nós montado a partir do `brand.json`, não o kit real do tenant.
