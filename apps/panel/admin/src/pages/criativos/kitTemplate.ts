import type { CatalogAngle } from '../../api/criativos';

// Campos do Brand Kit e do Niche Kit em linguagem de lojista (contratos BrandKit/NicheKit do core,
// services/creative-core/creative_core/schemas). Serve ao formulário guiado e ao prompt que o lojista
// leva ao ChatGPT — os dois leem daqui pra nunca divergirem.

export type KitKind = 'brand-kits' | 'niche-kits';

export interface CampoLista {
  key: string;
  label: string;
  hint: string;
  // O que o ChatGPT deve escrever nesse campo (vai no prompt).
  instrucao: string;
}

export interface SecaoKit {
  title: string;
  description: string;
  campos: CampoLista[];
}

export const LIMITE_ITEM = 500;
export const LIMITE_ITENS = 100;
export const LIMITE_NOME = 200;
export const LIMITE_DESCRICAO = 2000;

export const SECOES_MARCA: SecaoKit[] = [
  {
    title: 'Posicionamento',
    description: 'O que a marca é e para quem ela existe.',
    campos: [
      { key: 'positioning', label: 'Como a marca se posiciona', hint: 'Um por linha. Ex.: premium acessível; feito à mão; não é souvenir.', instrucao: 'como a marca se posiciona no mercado, em frases curtas' },
      { key: 'audience', label: 'Para quem vende', hint: 'Um por linha. Ex.: quem mora longe da cidade natal; quem compra presente.', instrucao: 'quem compra e por quê, um perfil por item' },
    ],
  },
  {
    title: 'Jeito de falar',
    description: 'Orienta headline, CTA e copy dos anúncios.',
    campos: [
      { key: 'tone', label: 'Tom de voz', hint: 'Um por linha. Ex.: direto; afetivo; sem gíria.', instrucao: 'adjetivos ou regras curtas de tom de voz' },
      { key: 'headlineStyle', label: 'Estilo de headline', hint: 'Um por linha. Ex.: curta e afetiva; nunca urgência falsa.', instrucao: 'como devem ser as headlines' },
      { key: 'ctaStyle', label: 'Estilo de chamada (CTA)', hint: 'Um por linha. Ex.: descreve a próxima ação real.', instrucao: 'como devem ser os botões/chamadas para ação' },
    ],
  },
  {
    title: 'Visual',
    description: 'Como as imagens devem parecer.',
    campos: [
      { key: 'visualStyle', label: 'Estilo visual', hint: 'Um por linha. Ex.: editorial; luz natural; minimalista.', instrucao: 'estilo visual das fotos e artes' },
      { key: 'colors', label: 'Cores da marca', hint: 'Uma por linha, em hex (#4d543d) ou pelo nome.', instrucao: 'cores da marca em hexadecimal quando conhecidas' },
      { key: 'typographyNotes', label: 'Tipografia', hint: 'Um por linha. Ex.: headline serifada; apoio em sans limpa.', instrucao: 'fontes ou estilo tipográfico da marca' },
      { key: 'preferredContexts', label: 'Cenários que combinam', hint: 'Um por linha. Ex.: cozinha clara com luz lateral; rua da cidade.', instrucao: 'cenários concretos onde o produto aparece bem em foto' },
    ],
  },
  {
    title: 'Limites',
    description: 'O que o gerador nunca deve fazer.',
    campos: [
      { key: 'avoid', label: 'Evitar', hint: 'Um por linha. Ex.: excesso de texto; clichê; logotipo de terceiros.', instrucao: 'o que nunca deve aparecer nos criativos' },
      { key: 'manualNotes', label: 'Observações', hint: 'Um por linha. Regras específicas da marca.', instrucao: 'regras específicas da marca que não cabem nos outros campos' },
    ],
  },
];

export const SECOES_NICHO: SecaoKit[] = [
  {
    title: 'Produto e público',
    description: 'O que se vende nesse nicho e como o cliente se comporta.',
    campos: [
      { key: 'productTypes', label: 'Tipos de produto', hint: 'Um por linha. Ex.: caneca; vela aromática; camiseta.', instrucao: 'tipos de produto vendidos nesse nicho' },
      { key: 'audienceBehaviors', label: 'Comportamento do público', hint: 'Um por linha. Ex.: quer ver o produto em uso antes de comprar.', instrucao: 'como o público desse nicho decide a compra' },
      { key: 'commonUsageScenarios', label: 'Situações de uso', hint: 'Um por linha. Ex.: café da manhã; presente de aniversário.', instrucao: 'situações em que o produto é usado' },
      { key: 'activities', label: 'Ações nas cenas', hint: 'Um por linha. Ex.: servir café; abrir a embalagem.', instrucao: 'ações que uma pessoa pode fazer com o produto numa foto' },
    ],
  },
  {
    title: 'Cena',
    description: 'Ambientes e materiais realistas para o nicho.',
    campos: [
      { key: 'sceneContexts', label: 'Ambientes', hint: 'Um por linha, bem concretos. Ex.: bancada de madeira clara com luz natural.', instrucao: 'ambientes concretos e realistas para fotografar o produto' },
      { key: 'materials', label: 'Materiais e texturas', hint: 'Um por linha. Ex.: cerâmica fosca; linho cru.', instrucao: 'materiais, texturas e objetos de apoio que combinam' },
    ],
  },
  {
    title: 'Limites',
    description: 'O que deixa o criativo com cara de genérico ou errado.',
    campos: [
      { key: 'visualCliches', label: 'Clichês a evitar', hint: 'Um por linha. Ex.: fundo branco chapado; mão flutuando.', instrucao: 'clichês visuais comuns nesse nicho que devem ser evitados' },
      { key: 'avoid', label: 'Evitar', hint: 'Um por linha. Ex.: produto distorcido; texto inventado.', instrucao: 'o que nunca deve aparecer nos criativos desse nicho' },
    ],
  },
];

export const secoesDoKit = (kind: KitKind) => (kind === 'brand-kits' ? SECOES_MARCA : SECOES_NICHO);
export const campoDeAngulos = (kind: KitKind) => (kind === 'brand-kits' ? 'enabledAngles' : 'recommendedAngles');

export const PROVEDORES_CONTEXTO = [
  { value: 'geographic', label: 'Região do produto (cidade/UF)' },
  { value: 'niche', label: 'Cenas do nicho' },
  { value: 'custom', label: 'Perfil de contexto aprovado' },
] as const;

// ── Prompt para o ChatGPT ───────────────────────────────────────────────────

export function montarPromptChatGpt(kind: KitKind, angles: CatalogAngle[], nichosEmbutidos: { id: string; name: string }[]): string {
  const marca = kind === 'brand-kits';
  const campoAngulos = campoDeAngulos(kind);
  const modelo: Record<string, unknown> = { name: marca ? 'nome da marca' : 'nome do nicho' };
  if (marca) modelo.description = 'resumo da marca em 1 a 3 frases';
  for (const secao of secoesDoKit(kind)) {
    for (const campo of secao.campos) modelo[campo.key] = [campo.instrucao];
  }
  modelo[campoAngulos] = ['CODIGO_DO_ANGULO'];
  if (marca) {
    modelo.defaultNicheKitId = nichosEmbutidos.map((n) => n.id).join(' | ');
    modelo.defaultContextProvider = 'geographic | niche | custom';
  } else {
    modelo.supportsApparelAngles = false;
  }

  const perguntas = marca
    ? [
        'Nome da loja e o que ela vende.',
        'Para quem vende e por que as pessoas compram.',
        'Como a marca fala (tom) e como ela NÃO quer soar.',
        'Estilo visual, cores (em hex, se souber) e fontes da marca.',
        'Onde os produtos ficam bonitos em foto e o que evitar nas imagens.',
        'Site ou Instagram da loja, se quiser que você considere.',
      ]
    : [
        'Qual é o nicho e quais tipos de produto a loja vende.',
        'Como o cliente desse nicho decide a compra.',
        'Em que situações e ambientes o produto é usado.',
        'Se os produtos são roupas/vestuário (camiseta, moletom, vestido...).',
        'Clichês de foto desse nicho que você acha genéricos.',
      ];

  const listaAngulos = angles
    .map((a) => `- ${a.id}: ${a.label} — ${a.description}${a.apparel_only ? ' (só para vestuário)' : ''}`)
    .join('\n');

  const regrasExtras = marca
    ? [
        `- "defaultNicheKitId": use ${nichosEmbutidos.map((n) => `"${n.id}" (${n.name})`).join(' ou ')}.`,
        '- "defaultContextProvider": "geographic" se os produtos têm cidade/região, "niche" para cenas do nicho, "custom" só se eu pedir um contexto próprio.',
      ]
    : ['- "supportsApparelAngles": true só se os produtos forem roupas/vestuário; caso contrário false.'];

  return [
    `Você vai me ajudar a montar o ${marca ? 'Brand Kit da minha marca' : 'Niche Kit do meu nicho'} para um gerador de criativos de anúncios (imagens para Instagram e Facebook).`,
    '',
    'Primeiro, me faça estas perguntas numa única mensagem e espere minhas respostas:',
    ...perguntas.map((p, i) => `${i + 1}. ${p}`),
    '',
    'Depois das minhas respostas, devolva SOMENTE um bloco de código JSON válido, sem comentários e sem texto fora do bloco, exatamente com estas chaves:',
    '```json',
    JSON.stringify(modelo, null, 2),
    '```',
    '',
    'Regras:',
    '- Tudo em português do Brasil, concreto e específico da minha loja (nada genérico).',
    `- Cada item de lista com no máximo ${LIMITE_ITEM} caracteres; de 3 a 8 itens por lista.`,
    `- "${campoAngulos}": escolha só códigos desta lista, os que fazem sentido para a loja:`,
    listaAngulos,
    ...regrasExtras,
    '- Não invente dados que eu não informei: prêmios, número de clientes, depoimentos, avaliações ou preços.',
    '- Não inclua as chaves id, version nem schemaVersion.',
  ].join('\n');
}

// ── Leitura da resposta colada ──────────────────────────────────────────────

export interface LeituraResposta {
  data: Record<string, unknown>;
  ignorados: string[];
}

// Aceita a resposta inteira do ChatGPT: com ou sem ```json, com texto antes/depois.
export function extrairJson(texto: string): unknown {
  const bloco = texto.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidato = bloco ? bloco[1] : texto;
  const inicio = candidato.indexOf('{');
  const fim = candidato.lastIndexOf('}');
  const incompleto = 'O JSON da resposta está incompleto ou com erro. Peça ao ChatGPT: "devolva só o JSON válido de novo".';
  if (inicio === -1) throw new Error('Não encontrei um JSON na resposta. Copie o bloco de código inteiro que o ChatGPT devolveu.');
  if (fim <= inicio) throw new Error(incompleto);
  try {
    return JSON.parse(candidato.slice(inicio, fim + 1));
  } catch {
    throw new Error(incompleto);
  }
}

export const listaDeTextos = (valor: unknown): string[] | null => {
  if (typeof valor === 'string') valor = valor.split('\n');
  if (!Array.isArray(valor)) return null;
  return valor
    .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v).trim().slice(0, LIMITE_ITEM))
    .filter(Boolean)
    .slice(0, LIMITE_ITENS);
};

// Mantém só o que o contrato do kit aceita, com os limites do contrato — o servidor ainda valida no salvar.
export function lerRespostaDoKit(kind: KitKind, texto: string, angles: CatalogAngle[], nichosEmbutidos: { id: string }[]): LeituraResposta {
  const bruto = extrairJson(texto);
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new Error('A resposta precisa ser um objeto JSON, entre chaves { }.');
  const entrada = bruto as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const aceitos = new Set<string>();
  const marca = kind === 'brand-kits';

  if (typeof entrada.name === 'string' && entrada.name.trim()) {
    data.name = entrada.name.trim().slice(0, LIMITE_NOME);
    aceitos.add('name');
  }
  if (marca && typeof entrada.description === 'string') {
    data.description = entrada.description.trim().slice(0, LIMITE_DESCRICAO);
    aceitos.add('description');
  }
  for (const secao of secoesDoKit(kind)) {
    for (const campo of secao.campos) {
      const lista = listaDeTextos(entrada[campo.key]);
      if (lista) {
        data[campo.key] = lista;
        aceitos.add(campo.key);
      }
    }
  }
  const campoAngulos = campoDeAngulos(kind);
  const validos = new Set(angles.map((a) => a.id));
  const angulos = listaDeTextos(entrada[campoAngulos]);
  if (angulos) {
    data[campoAngulos] = [...new Set(angulos.map((a) => a.toUpperCase()).filter((a) => validos.has(a)))];
    aceitos.add(campoAngulos);
  }
  if (marca) {
    if (typeof entrada.defaultNicheKitId === 'string' && nichosEmbutidos.some((n) => n.id === entrada.defaultNicheKitId)) {
      data.defaultNicheKitId = entrada.defaultNicheKitId;
      aceitos.add('defaultNicheKitId');
    }
    if (PROVEDORES_CONTEXTO.some((p) => p.value === entrada.defaultContextProvider)) {
      data.defaultContextProvider = entrada.defaultContextProvider;
      aceitos.add('defaultContextProvider');
    }
  } else if (typeof entrada.supportsApparelAngles === 'boolean') {
    data.supportsApparelAngles = entrada.supportsApparelAngles;
    aceitos.add('supportsApparelAngles');
  }

  if (aceitos.size === 0) throw new Error('A resposta não tem nenhum campo do kit. Confira se colou a resposta do prompt certo.');
  const ignorados = Object.keys(entrada).filter((k) => !aceitos.has(k));
  return { data, ignorados };
}

// ── Conversão formulário ↔ dados do kit ─────────────────────────────────────

export const listaParaTexto = (valor: unknown): string => (Array.isArray(valor) ? valor.filter((v) => typeof v === 'string').join('\n') : '');

export const textoParaLista = (texto: string): string[] =>
  texto.split('\n').map((l) => l.trim()).filter(Boolean);
