'use strict';

// Fase 6 · a operação interna não tem caminho próprio no código de produto.
//
// Critério de saída 2 da Fase 6: nada de `if (internalTenant)`, `useOrigens`, `isOurStore` — nem
// variações: nome de loja legada, nome de Organization ou UUID fixo usados como DECISÃO. A Use
// Origens (cenário A ou B de PD-019) roda como qualquer Organization; se precisar de algo diferente,
// isso vira dado (entitlement, integração, mapeamento), nunca um ramo de código.
//
// Usado por test/invariants/fase6-tenant1-static.test.js (com controle negativo) e pelo
// `npm run tenant1:verify` (item `bypass.codigo`).
//
// O que NÃO é violação (e por isso não casa): o mapa de rótulos das lojas legadas para exibição
// (`LOJAS` em server.js, `adminStores.ts`), textos e comentários sobre a ferramenta interna
// "Migração Use Origens" (R-01, LEGACY/TO_REMOVE, atrás de INTERNAL_TOOLS_ENABLED) e exemplos de
// placeholder em tela. Nenhum deles decide dono, acesso ou comportamento por Organization.

const fs = require('fs');
const path = require('path');

const PADROES = Object.freeze([
  {
    id: 'identificador-de-tenant-interno',
    descricao: 'identificador que distingue a operação interna (internalTenant, isOurStore, useOrigens, tenant1...)',
    re: /\b(?:is|eh)?_?(?:internal_?(?:tenant|org|organization|store)s?|our_?(?:store|org|organization|tenant)s?|use_?origens|tenant_?(?:1|um|zero|interno|principal)|loja_?(?:interna|principal|nossa)|nossa_?loja|org_?interna|organizacao_?interna|operacao_?interna)/i,
    // Sem \b no fim de propósito: `useOrigensMode` e `isInternalTenantFlag` também contam.
  },
  {
    id: 'flag-de-ambiente-de-bypass',
    descricao: 'variável de ambiente que liga um caminho especial para um tenant',
    re: /process\.env\.\w*(?:INTERNAL_TENANT|INTERNAL_ORG|USE_ORIGENS|OUR_STORE|TENANT_?1\b|BYPASS|SUPER_?TENANT|PLATFORM_ADMIN)/,
  },
  {
    id: 'loja-legada-como-decisao',
    descricao: 'chave de loja legada (sul/centro/norte) comparada no código',
    re: /(?:===|!==|==|!=)\s*['"`](?:sul|centro|norte)['"`]|['"`](?:sul|centro|norte)['"`]\s*(?:===|!==|==|!=)|\bcase\s+['"`](?:sul|centro|norte)['"`]\s*:|\.(?:includes|has)\(\s*['"`](?:sul|centro|norte)['"`]\s*\)|\[\s*['"`](?:sul|centro|norte)['"`][^\]]*\]\s*\.(?:includes|indexOf)\(/,
  },
  {
    id: 'nome-legado-como-decisao',
    descricao: 'nome de loja/Organization legada (Use Sul/Centro/Norte/Origens) comparado no código',
    re: /(?:===|!==|==|!=)\s*['"`][^'"`]*\bUse ?(?:Sul|Centro|Norte|Origens)\b|\bUse ?(?:Sul|Centro|Norte|Origens)\b[^'"`]*['"`]\s*(?:===|!==|==|!=)|\.(?:includes|startsWith|endsWith|indexOf|test|match)\(\s*(?:['"`][^'"`]*|\/[^/]*)\bUse ?(?:Sul|Centro|Norte|Origens)\b|\/[^/\s]*\bUse ?(?:Sul|Centro|Norte|Origens)\b[^/]*\/[gimsuy]*\.(?:test|exec)\(/i,
  },
  {
    id: 'uuid-fixo-como-decisao',
    descricao: 'id de Organization/Store fixo comparado no código',
    re: /(?:organization|org|tenant|store)_?id\w*\s*(?:===|!==|==|!=)\s*['"`][0-9a-f]{8}-[0-9a-f]{4}-|['"`][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"`]\s*(?:===|!==|==|!=)/i,
  },
  {
    id: 'sql-por-nome-de-organization',
    descricao: 'SQL que escolhe Organization/Store pelo nome',
    re: /\b(?:organizations|stores)\b[^;]*\bnome\s*(?:=|ILIKE|LIKE)\s*'/i,
  },
]);

// Exceções legítimas, com arquivo e motivo. Vazia hoje; o teste exige que cada exceção listada
// ainda case alguma linha (exceção que sobra vira buraco).
const EXCECOES = Object.freeze([]);

function ehComentario(linha) {
  const l = linha.trimStart();
  return l.startsWith('//') || l.startsWith('*') || l.startsWith('/*') || l.startsWith('{/*');
}

// Arquivos de produto: server.js, lib/ e routes/ da raiz do sujeito; src/ da raiz do painel (o
// frontend, que já morou em `admin/src` e subiu para a raiz do deployable).
function arquivosDeProduto({ raiz, raizAdmin = raiz }) {
  const js = ['lib', 'routes'].flatMap((d) => {
    const dir = path.join(raiz, d);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true }).filter((x) => x.endsWith('.js')).map((x) => path.join(dir, x));
  });
  const frontDir = path.join(raizAdmin, 'src');
  const ts = fs.existsSync(frontDir)
    ? fs.readdirSync(frontDir, { recursive: true }).filter((x) => /\.(ts|tsx)$/.test(x)).map((x) => path.join(frontDir, x))
    : [];
  return { raiz, raizAdmin, arquivos: [path.join(raiz, 'server.js'), ...js, ...ts] };
}

function rotulo(arquivo, { raiz, raizAdmin }) {
  const base = arquivo.startsWith(path.join(raizAdmin, 'src')) ? raizAdmin : raiz;
  return path.relative(base, arquivo);
}

// Devolve [{ padrao, onde, linha }]. Lista vazia = sem bypass.
function procurarBypassEmLinhas(nome, texto) {
  const achados = [];
  texto.split('\n').forEach((l, i) => {
    if (ehComentario(l)) return;
    for (const p of PADROES) {
      if (!p.re.test(l)) continue;
      if (EXCECOES.some((e) => e.arquivo === nome && e.re.test(l))) continue;
      achados.push({ padrao: p.id, onde: `${nome}:${i + 1}`, linha: l.trim().slice(0, 160) });
    }
  });
  return achados;
}

function procurarBypass(opcoes) {
  const alvo = arquivosDeProduto(opcoes);
  const achados = [];
  for (const arq of alvo.arquivos) {
    achados.push(...procurarBypassEmLinhas(rotulo(arq, alvo), fs.readFileSync(arq, 'utf8')));
  }
  return { achados, arquivos: alvo.arquivos.length };
}

module.exports = { PADROES, EXCECOES, procurarBypass, procurarBypassEmLinhas, arquivosDeProduto };
