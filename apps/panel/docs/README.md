# Claude Frontend Skills Pack

Pacote complementar para Claude Code focado em frontend de alta qualidade para SaaS/admin dashboards.

## Instale também o skill oficial da Anthropic
Use o plugin/skill oficial **Frontend Design** como base estética:
https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design

Este pacote adiciona regras mais específicas para dashboards operacionais, implementação por mockup e revisão visual.

## Skills do pacote
- `dashboard-ui-director`: direção visual/UX para dashboards operacionais dark e data-dense.
- `reference-ui-implementation`: transforma screenshot/mockup em tokens, proporções e componentes; exige comparação posterior.
- `visual-qa-reviewer`: crítico visual independente após a implementação.
- `design-system-guardian`: evita CSS e padrões divergentes entre páginas.
- `responsive-accessibility`: comportamento responsivo e acessibilidade.

## Instalação
Copie a pasta `.claude` para a raiz do projeto.

```bash
cp -R .claude /caminho/do/seu/projeto/
```

Estrutura esperada:

```text
.claude/
└── skills/
    ├── dashboard-ui-director/SKILL.md
    ├── reference-ui-implementation/SKILL.md
    ├── visual-qa-reviewer/SKILL.md
    ├── design-system-guardian/SKILL.md
    └── responsive-accessibility/SKILL.md
```

## Workflow recomendado

```text
1. reference-ui-implementation
2. dashboard-ui-director
3. design-system-guardian
4. responsive-accessibility
5. implementar
6. rodar app e capturar screenshot
7. visual-qa-reviewer
8. corrigir os 5 maiores gaps
9. capturar novamente
```

A direção visual deste projeto é dark premium, com blue-black/charcoal, superfícies em camadas, verde operacional, cyan informativo, âmbar para pendências, vermelho crítico, violeta terciário/premium, alta densidade, tabelas e drawers.
