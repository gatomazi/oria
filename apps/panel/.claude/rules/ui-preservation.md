---
paths:
  - "**/*.{css,scss,sass,less,html,jsx,tsx,js,ts,vue,svelte}"
---

# Preservação de UI

Ao editar interface:
- Preserve identidade visual, conteúdo e regras de negócio existentes.
- Faça responsividade por composição e CSS, não duplicando páginas inteiras por breakpoint sem necessidade.
- Não introduza biblioteca visual nova sem justificativa técnica explícita.
- Não use largura fixa mobile como wrapper principal em desktop.
- Não esconda bugs visuais com hacks que removem conteúdo.
- Sticky/fixed devem reservar espaço no fluxo quando necessário.
- Mantenha estados de foco visíveis.
