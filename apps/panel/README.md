# Orgulho Regional

> **"Todo mundo carrega um lugar. Vista o seu."**

Site hub que conecta pessoas à camiseta da sua cidade — direto para Use Sul ou Use Centro na Reserva Ink.

---

## Como funciona

1. Usuário digita o nome da cidade
2. Vê o preview da camiseta
3. Clica e vai direto para a página do produto

Resolve o problema de quem não encontra sua cidade navegando nas lojas — a busca vai de 2 toques até o produto.

---

## Stack

- HTML + CSS + JS puro — zero dependências, zero servidor
- `data/cities.json` estático gerado por scrape
- Hospedagem gratuita via Vercel

---

## Marcas

| Loja | Território |
|------|-----------|
| [Use Sul](https://www.usesul.com.br) | PR · SC · RS |
| [Use Centro](https://www.usecentro.com.br) | GO · MT · MS · DF |

**1.684 cidades** mapeadas com imagem e link direto para o produto.

---

## Rodar localmente

```bash
python3 -m http.server 3000
# acesse http://localhost:3000
```

## Atualizar o catálogo

```bash
node extract.js
```

Gera `data/cities.json` novo com todas as cidades e imagens atualizadas. O script salva progresso incremental em `data/cities_temp.json` a cada 20 produtos — se interrompido, basta rodar novamente.

---

## Deploy

Hospedado em [orgulhoregional.com.br](https://orgulhoregional.com.br) via Vercel.  
Domínio registrado no [registro.br](https://registro.br).
