import { LIMITE_DESCRICAO, LIMITE_ITEM, LIMITE_NOME, extrairJson, listaDeTextos, type SecaoKit } from './kitTemplate';

// Campos do perfil de contexto em linguagem de lojista (contrato ContextProfile do core,
// apps/creative-generator/creative_core/schemas). Serve ao formulário guiado e ao prompt do ChatGPT.
// Na geração, o core usa as cenas (uma por imagem), os detalhes de apoio e o "evitar"
// (context_intelligence.py); os demais campos ficam no perfil como referência.

export type TipoContexto = 'custom' | 'geographic' | 'niche' | 'bond' | 'neutral';

export const TIPOS_CONTEXTO: { value: TipoContexto; label: string; instrucao: string }[] = [
  { value: 'custom', label: 'Tema próprio da loja', instrucao: 'um tema ou universo próprio da loja' },
  { value: 'geographic', label: 'Cidade ou região', instrucao: 'uma cidade, estado ou região' },
  { value: 'niche', label: 'Nicho de mercado', instrucao: 'um nicho ou mercado (ex.: café, pets, casa)' },
  { value: 'bond', label: 'Vínculo ou comunidade', instrucao: 'um grupo com vínculo afetivo (time, profissão, turma, família)' },
  { value: 'neutral', label: 'Neutro', instrucao: 'um cenário neutro, sem referência a lugar ou grupo' },
];

export const STATUS_CONTEXTO = [
  { value: 'draft', label: 'Rascunho' },
  { value: 'approved', label: 'Aprovado' },
  { value: 'rejected', label: 'Rejeitado' },
] as const;

export const SECOES_CONTEXTO: SecaoKit[] = [
  {
    title: 'Cenas',
    description: 'Onde o criativo acontece. O gerador usa uma cena por imagem e evita repetir as recentes.',
    campos: [
      { key: 'sceneContexts', label: 'Cenas', hint: 'Uma por linha, bem concretas. Obrigatório para aprovar. Ex.: varanda de casa de madeira com luz de fim de tarde.', instrucao: 'cenas concretas, fotografáveis e contemporâneas onde o produto aparece' },
    ],
  },
  {
    title: 'Detalhes de apoio',
    description: 'Um detalhe discreto entra em cada imagem para dar identidade sem virar caricatura.',
    campos: [
      { key: 'domainElements', label: 'Elementos em cenas com pessoa', hint: 'Um por linha. Ex.: cuia de chimarrão na mesa; bicicleta encostada no muro.', instrucao: 'objetos e símbolos reconhecíveis desse contexto que podem aparecer discretos numa cena com pessoa' },
      { key: 'visualSignatures', label: 'Clima em fotos só do produto', hint: 'Um por linha: paleta, luz e texturas. Ex.: verde-musgo e madeira escura; neblina de manhã.', instrucao: 'cores, luz e texturas que evocam esse contexto sem mostrar o lugar' },
    ],
  },
  {
    title: 'Mais referências',
    description: 'Complementam o perfil e ajudam a manter o contexto coerente entre edições.',
    campos: [
      { key: 'activities', label: 'Atividades', hint: 'Um por linha. Ex.: tomar café na padaria; pedalar na ciclovia.', instrucao: 'atividades comuns de quem vive esse contexto' },
      { key: 'materials', label: 'Materiais e texturas', hint: 'Um por linha. Ex.: tijolo aparente; lã crua.', instrucao: 'materiais e texturas típicos desse contexto' },
      { key: 'environment', label: 'Ambiente e clima', hint: 'Um por linha. Ex.: inverno com geada; litoral ensolarado.', instrucao: 'clima, estação e características do ambiente' },
    ],
  },
  {
    title: 'Limites',
    description: 'O que nunca deve aparecer: soma-se ao que o Brand Kit e o Niche Kit já evitam.',
    campos: [
      { key: 'avoid', label: 'Evitar', hint: 'Um por linha. Ex.: cartão-postal turístico; estereótipo de sotaque; bandeira oficial.', instrucao: 'o que soaria caricato, turístico, ofensivo ou errado para quem é desse contexto' },
    ],
  },
];

export const tiposValidos = new Set<string>(TIPOS_CONTEXTO.map((t) => t.value));

// ── Prompt para o ChatGPT ───────────────────────────────────────────────────

export function montarPromptContexto(): string {
  const modelo: Record<string, unknown> = {
    name: 'nome curto do contexto',
    contextType: TIPOS_CONTEXTO.map((t) => t.value).join(' | '),
    summary: 'resumo do contexto em 1 a 3 frases',
  };
  for (const secao of SECOES_CONTEXTO) {
    for (const campo of secao.campos) modelo[campo.key] = [campo.instrucao];
  }

  return [
    'Você vai me ajudar a montar um perfil de contexto para um gerador de criativos de anúncios (imagens para Instagram e Facebook). O contexto define as cenas e os detalhes que dão identidade às fotos dos produtos.',
    '',
    'Primeiro, me faça estas perguntas numa única mensagem e espere minhas respostas:',
    '1. Qual é o contexto: uma cidade ou região, um tema da loja, uma comunidade (time, profissão, turma) ou um nicho.',
    '2. Que produtos a loja vende e quem compra.',
    '3. Lugares e situações do dia a dia onde esse público realmente está.',
    '4. Objetos, símbolos e detalhes que quem é desse contexto reconhece de cara.',
    '5. Cores, luz e clima que lembram esse contexto.',
    '6. O que soaria caricato, turístico ou ofensivo e precisa ficar de fora.',
    '',
    'Depois das minhas respostas, devolva SOMENTE um bloco de código JSON válido, sem comentários e sem texto fora do bloco, exatamente com estas chaves:',
    '```json',
    JSON.stringify(modelo, null, 2),
    '```',
    '',
    'Regras:',
    '- Tudo em português do Brasil, concreto e específico (nada genérico).',
    `- Cada item de lista com no máximo ${LIMITE_ITEM} caracteres; de 3 a 8 itens por lista.`,
    '- "sceneContexts": cenas reais e atuais, do jeito que quem mora ou vive esse contexto vê; nada de cartão-postal.',
    `- "contextType": use ${TIPOS_CONTEXTO.map((t) => `"${t.value}" para ${t.instrucao}`).join('; ')}.`,
    '- Não invente fatos que eu não informei: datas, prêmios, números, depoimentos ou nomes de pessoas reais.',
    '- Não inclua as chaves contextId, status, schemaVersion, promptVersion nem profileVersion.',
  ].join('\n');
}

// ── Leitura da resposta colada ──────────────────────────────────────────────

export interface LeituraContexto {
  data: Record<string, unknown>;
  ignorados: string[];
}

// Mantém só o que o contrato aceita, com os limites do contrato — o servidor ainda valida no salvar.
export function lerRespostaDoContexto(texto: string): LeituraContexto {
  const bruto = extrairJson(texto);
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new Error('A resposta precisa ser um objeto JSON, entre chaves { }.');
  const entrada = bruto as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const aceitos = new Set<string>();

  // Aceita tanto "name" quanto "subject": { "name" } — o ChatGPT às vezes devolve no formato do contrato.
  const subject = entrada.subject && typeof entrada.subject === 'object' && !Array.isArray(entrada.subject) ? (entrada.subject as Record<string, unknown>) : null;
  const nome = typeof entrada.name === 'string' ? entrada.name : typeof subject?.name === 'string' ? subject.name : '';
  if (nome.trim()) {
    data.subject = { name: nome.trim().slice(0, LIMITE_NOME) };
    if (typeof entrada.name === 'string') aceitos.add('name');
    if (subject) aceitos.add('subject');
  }
  if (typeof entrada.contextType === 'string' && tiposValidos.has(entrada.contextType)) {
    data.contextType = entrada.contextType;
    aceitos.add('contextType');
  }
  if (typeof entrada.summary === 'string') {
    data.summary = entrada.summary.trim().slice(0, LIMITE_DESCRICAO);
    aceitos.add('summary');
  }
  for (const secao of SECOES_CONTEXTO) {
    for (const campo of secao.campos) {
      const lista = listaDeTextos(entrada[campo.key]);
      if (lista) {
        data[campo.key] = lista;
        aceitos.add(campo.key);
      }
    }
  }

  if (aceitos.size === 0) throw new Error('A resposta não tem nenhum campo do contexto. Confira se colou a resposta do prompt certo.');
  const ignorados = Object.keys(entrada).filter((k) => !aceitos.has(k));
  return { data, ignorados };
}
