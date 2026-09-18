import { useSyncExternalStore } from 'react';

// Porte da lógica de dados de src/admin/template-editor.js (sem DOM — os widgets viram
// componentes React em components/template-editor/*). Estado de GRUPOS_VARIAVEIS é module-level
// e compartilhado entre páginas, igual ao original (`definirCamposCustomizados` é chamado 1x por
// página depois de buscar /api/admin/campos-customizados), exposto como external store pra
// componentes re-renderizarem quando os campos personalizados chegam.

export type VariavelTipo = 'comum' | 'pedido' | 'carrinho' | 'campanha';

export interface VariavelItem {
  chave: string;
  label: string;
  exemplo: string;
}

export interface VariavelGrupo {
  grupo: string;
  tipo: VariavelTipo;
  itens: VariavelItem[];
}

const GRUPOS_BASE: VariavelGrupo[] = [
  {
    grupo: 'Cliente',
    tipo: 'comum',
    itens: [
      { chave: 'cliente.nome', label: 'Nome do cliente', exemplo: 'Maria' },
      { chave: 'cliente.email', label: 'E-mail do cliente', exemplo: 'maria@exemplo.com' },
      { chave: 'cliente.telefone', label: 'Telefone do cliente', exemplo: '5548999998888' },
    ],
  },
  {
    grupo: 'Loja',
    tipo: 'comum',
    itens: [{ chave: 'loja.nome', label: 'Nome da loja', exemplo: 'Use Sul' }],
  },
  {
    grupo: 'Pedido',
    tipo: 'pedido',
    itens: [
      { chave: 'cliente.documento', label: 'CPF/CNPJ do cliente', exemplo: '12345678900' },
      { chave: 'pedido.numero', label: 'Número do pedido (com prefixo INK)', exemplo: 'INK1234567' },
      { chave: 'pedido.numero_sem_prefixo', label: 'Número do pedido (sem prefixo INK)', exemplo: '1234567' },
      { chave: 'pedido.status', label: 'Status do pedido', exemplo: 'Em produção' },
      { chave: 'pedido.valor', label: 'Valor total do pedido', exemplo: 'R$ 129,90' },
      { chave: 'pedido.metodo_pagamento', label: 'Método de pagamento', exemplo: 'Pix' },
      { chave: 'pedido.itens', label: 'Itens do pedido (lista)', exemplo: '2x Camiseta Azul, 1x Camiseta Preta' },
      { chave: 'pedido.transportadora', label: 'Transportadora', exemplo: 'Correios' },
      { chave: 'pedido.previsao_entrega', label: 'Previsão de entrega', exemplo: '15/09/2026' },
      { chave: 'pedido.rastreio', label: 'Link de rastreio', exemplo: 'https://exemplo.com/rastreio' },
      {
        chave: 'pedido.link_pagamento',
        label: 'Link de pagamento completo — pro CORPO do texto (só evento pix.pendente)',
        exemplo: 'https://orgulhoregional.com.br/hotpix/AbCdEfGhIj',
      },
      {
        chave: 'pedido.id_pagamento',
        label: 'ID de pagamento — pro botão de link dinâmico, ex: https://seusite.com/{{1}} (só evento pix.pendente)',
        exemplo: 'AbCdEfGhIj',
      },
      { chave: 'produto.nome', label: 'Nome do produto (1º item do pedido)', exemplo: 'Camiseta Exemplo' },
      { chave: 'link', label: 'Link genérico', exemplo: 'https://exemplo.com/rastreio' },
    ],
  },
  {
    // Só existe em mensagens de campanha do WhatsApp Web (dado agregado do cliente, resolvido no
    // disparo da campanha) — templates da Meta mapeiam esses dados na própria tela da campanha.
    grupo: 'Histórico do cliente',
    tipo: 'campanha',
    itens: [
      { chave: 'cliente.primeiro_nome', label: 'Primeiro nome', exemplo: 'Maria' },
      { chave: 'cliente.quantidade_pedidos', label: 'Quantidade de pedidos', exemplo: '3' },
      { chave: 'cliente.total_gasto', label: 'Total gasto', exemplo: 'R$ 389.70' },
      { chave: 'cliente.ticket_medio', label: 'Ticket médio', exemplo: 'R$ 129.90' },
      { chave: 'cliente.ultima_compra', label: 'Data da última compra', exemplo: '02/08/2026' },
    ],
  },
  {
    grupo: 'Carrinho abandonado',
    tipo: 'carrinho',
    itens: [
      { chave: 'carrinho.produto', label: 'Primeiro produto do carrinho', exemplo: 'Camiseta Exemplo' },
      { chave: 'carrinho.itens', label: 'Itens do carrinho (lista)', exemplo: '2x Camiseta Azul' },
      { chave: 'carrinho.quantidade_itens', label: 'Quantidade de itens no carrinho', exemplo: '2' },
      { chave: 'carrinho.uuid', label: 'UUID do carrinho (pra montar link de recuperação)', exemplo: '2ab47679-1726-4d27-bc0b-1deda4f011c4' },
    ],
  },
];

let gruposVariaveis: VariavelGrupo[] = GRUPOS_BASE;
let exemplosPorChave: Record<string, string> = {};
const listeners = new Set<() => void>();

function recalcularDerivados() {
  exemplosPorChave = {};
  gruposVariaveis.forEach((g) => g.itens.forEach((v) => { exemplosPorChave[v.chave] = v.exemplo; }));
}
recalcularDerivados();

export interface CampoCustomizadoRef {
  chave: string;
  label: string;
}

// `campos`: vindo de GET /api/admin/campos-customizados (chave SEM o prefixo `custom.`).
export function definirCamposCustomizados(campos: CampoCustomizadoRef[] | null | undefined): void {
  let semCustom = GRUPOS_BASE.filter((g) => g.grupo !== 'Personalizados');
  if (campos && campos.length) {
    semCustom = semCustom.concat([
      {
        grupo: 'Personalizados',
        tipo: 'comum',
        itens: campos.map((c) => ({ chave: 'custom.' + c.chave, label: c.label, exemplo: '(valor definido por loja)' })),
      },
    ]);
  }
  gruposVariaveis = semCustom;
  recalcularDerivados();
  listeners.forEach((fn) => fn());
}

export function useGruposVariaveis(): VariavelGrupo[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => gruposVariaveis,
  );
}

export interface CampoCustomizadoCompleto {
  valores?: Record<string, string>;
}

// O preview de um vínculo já sabe pra qual loja é — troca "(valor definido por loja)" pelo valor
// real configurado pra ESSA loja. `camposCustomizados`: objeto completo de
// GET /api/admin/campos-customizados (com `valores`).
export function construirOverridesCampos(
  camposCustomizados: Record<string, CampoCustomizadoCompleto> | null | undefined,
  loja: string,
): Record<string, string> {
  const overrides: Record<string, string> = {};
  Object.keys(camposCustomizados || {}).forEach((chave) => {
    const campo = (camposCustomizados as Record<string, CampoCustomizadoCompleto>)[chave];
    const valor = campo.valores && campo.valores[loja];
    overrides['custom.' + chave] = valor || '(sem valor definido pra essa loja)';
  });
  return overrides;
}

// Tipo desconhecido/não informado não restringe nada — mostra a união de tudo.
export function gruposParaTipo(tipo: string | null | undefined): VariavelGrupo[] {
  if (tipo !== 'pedido' && tipo !== 'carrinho') return gruposVariaveis.filter((g) => g.tipo !== 'campanha');
  return gruposVariaveis.filter((g) => g.tipo === 'comum' || g.tipo === tipo);
}

// Mensagens do WhatsApp Web: "comum" pode ser vinculada a qualquer evento, então só oferece as
// variáveis que existem em todos (diferente de gruposParaTipo, onde tipo desconhecido mostra tudo).
export function gruposParaMensagemWeb(tipo: 'comum' | 'pedido' | 'carrinho' | 'campanha'): VariavelGrupo[] {
  if (tipo === 'comum') return gruposVariaveis.filter((g) => g.tipo === 'comum');
  return gruposVariaveis.filter((g) => g.tipo === 'comum' || g.tipo === tipo);
}

// Troca {{chave}} nomeada pelo exemplo (ou override por loja) — prévia das mensagens do WhatsApp
// Web, que usam o nome da variável direto no texto em vez de {{1}}, {{2}}.
export function substituirVariaveisNomeadas(texto: string | null | undefined, overrides?: Record<string, string> | null): string {
  if (!texto) return '';
  return texto.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, chave: string) => {
    const valorOverride = overrides?.[chave];
    if (valorOverride != null) return valorOverride;
    const exemplo = exemplosPorChave[chave];
    return exemplo != null ? exemplo : match;
  });
}

export function chaveValidaParaTipo(chave: string, tipo: string | null | undefined): boolean {
  return gruposParaTipo(tipo).some((g) => g.itens.some((v) => v.chave === chave));
}

// Meta suporta 2 formatos de variável: posicional ({{1}}, {{2}}) e nomeado ({{customer_name}}).
// Extrai o token cru na ordem de 1ª aparição, sem duplicata.
export function extrairTokensVariaveis(texto: string | null | undefined): string[] {
  if (!texto) return [];
  const vistos: Record<string, boolean> = {};
  const ordenados: string[] = [];
  (texto.match(/\{\{([^{}]+)\}\}/g) || []).forEach((m) => {
    const token = m.slice(2, -2).trim();
    if (!vistos[token]) {
      vistos[token] = true;
      ordenados.push(token);
    }
  });
  return ordenados;
}

export function contarVariaveis(texto: string | null | undefined): number {
  return extrairTokensVariaveis(texto).length;
}

export function substituirVariaveis(
  texto: string | null | undefined,
  chavesPorIndice: (string | null | undefined)[] | null | undefined,
  overrides?: Record<string, string> | null,
): string {
  if (!texto) return '';
  const indicePorToken: Record<string, number> = {};
  let proximoIndice = 0;
  return texto.replace(/\{\{([^{}]+)\}\}/g, (match, tokenBruto: string) => {
    const token = tokenBruto.trim();
    if (!(token in indicePorToken)) {
      indicePorToken[token] = proximoIndice;
      proximoIndice++;
    }
    const chave = (chavesPorIndice || [])[indicePorToken[token]];
    if (!chave) return match;
    const valorOverride = overrides?.[chave];
    if (valorOverride != null) return valorOverride;
    const exemplo = exemplosPorChave[chave];
    return exemplo != null ? exemplo : match;
  });
}

export type BotaoTipo = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';

export interface TemplateBotao {
  texto: string;
  tipo: BotaoTipo | string;
  valor: string | null;
}

export interface TemplateComponent {
  type: string;
  format?: string;
  text?: string;
  buttons?: { text: string; type: string; url?: string; phone_number?: string }[];
}

export interface TextosComponentes {
  header: string | null;
  corpo: string | null;
  footer: string | null;
  botoes: TemplateBotao[];
}

// Extrai o texto do cabeçalho (TEXT) e do corpo a partir do array `components` que a Meta
// devolve na listagem.
export function extrairTextosComponentes(components: TemplateComponent[] | null | undefined): TextosComponentes {
  let header: string | null = null;
  let corpo: string | null = null;
  let footer: string | null = null;
  let botoes: TemplateBotao[] = [];
  (components || []).forEach((c) => {
    if (c.type === 'HEADER' && c.format === 'TEXT') header = c.text ?? null;
    if (c.type === 'BODY') corpo = c.text ?? null;
    if (c.type === 'FOOTER') footer = c.text ?? null;
    if (c.type === 'BUTTONS') {
      botoes = (c.buttons || []).map((b) => ({ texto: b.text, tipo: b.type, valor: b.url || b.phone_number || null }));
    }
  });
  return { header, corpo, footer, botoes };
}

// Acha o botão de link (URL) dinâmico direto na estrutura real da Meta.
export function extrairBotaoDinamico(components: TemplateComponent[] | null | undefined): { indice: number } | null {
  const buttonsComp = (components || []).find((c) => c.type === 'BUTTONS');
  if (!buttonsComp) return null;
  let indice = -1;
  (buttonsComp.buttons || []).forEach((b, i) => {
    if (indice === -1 && b.type === 'URL' && /\{\{[^{}]+\}\}/.test(b.url || '')) indice = i;
  });
  return indice === -1 ? null : { indice };
}
