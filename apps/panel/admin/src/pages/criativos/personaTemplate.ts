import { extrairJson } from './kitTemplate';

// Campos da persona em linguagem de lojista (contrato Persona do core). O core monta a descrição da
// pessoa em cena com rótulo; aparência; estilo; comportamento; notas (personas.py::describe), e o
// rótulo entra no lugar de "uma pessoa" nos ângulos — por isso ele descreve, não dá nome próprio.

export interface CampoPersona {
  key: 'label' | 'age_range' | 'appearance' | 'style' | 'behavior' | 'notes';
  label: string;
  hint: string;
  limite: number;
  // O que o ChatGPT deve escrever nesse campo (vai no prompt).
  instrucao: string;
}

export const CAMPOS_PERSONA: CampoPersona[] = [
  { key: 'label', label: 'Quem é', hint: 'Descrição curta, sem nome próprio. Ex.: Mulher 30-40 anos, estilo casual.', limite: 200, instrucao: 'descrição curta de quem aparece na foto, sem nome próprio' },
  { key: 'age_range', label: 'Faixa de idade', hint: 'Ex.: 30-40.', limite: 80, instrucao: 'faixa de idade, ex.: 25-35' },
  { key: 'appearance', label: 'Aparência', hint: 'Ex.: cabelo cacheado preso, pele morena, maquiagem leve.', limite: 1000, instrucao: 'aparência física natural e realista' },
  { key: 'style', label: 'Estilo de roupa', hint: 'Ex.: casual contemporâneo, jeans e tênis branco.', limite: 1000, instrucao: 'como se veste no dia a dia, sem marcas' },
  { key: 'behavior', label: 'Postura e gestos', hint: 'Ex.: sorriso leve, gestos naturais, olhando para o produto.', limite: 1000, instrucao: 'postura, expressão e gestos na foto' },
  { key: 'notes', label: 'Observações', hint: 'Regras extras para essa persona.', limite: 1000, instrucao: 'regras extras para a foto, se houver' },
];

export type DadosPersona = Record<CampoPersona['key'], string>;

export const PERSONA_VAZIA: DadosPersona = { label: '', age_range: '', appearance: '', style: '', behavior: '', notes: '' };

export function personaDeDados(dados: Record<string, unknown> | null | undefined): DadosPersona {
  const persona = { ...PERSONA_VAZIA };
  for (const campo of CAMPOS_PERSONA) {
    const valor = dados?.[campo.key];
    if (typeof valor === 'string') persona[campo.key] = valor;
  }
  return persona;
}

// ── Prompt para o ChatGPT ───────────────────────────────────────────────────

export function montarPromptPersona(): string {
  const modelo = Object.fromEntries(CAMPOS_PERSONA.map((c) => [c.key, c.instrucao]));
  return [
    'Você vai me ajudar a descrever uma persona: a pessoa que aparece usando meus produtos nas imagens de um gerador de criativos de anúncios (Instagram e Facebook).',
    '',
    'Primeiro, me faça estas perguntas numa única mensagem e espere minhas respostas:',
    '1. O que a loja vende e quem mais compra (idade, rotina, onde mora).',
    '2. Como esse cliente se veste no dia a dia.',
    '3. Que clima a foto deve passar (tranquila, divertida, sofisticada, afetiva...).',
    '4. Algo que a pessoa na foto nunca deve fazer ou vestir.',
    '',
    'Depois das minhas respostas, devolva SOMENTE um bloco de código JSON válido, sem comentários e sem texto fora do bloco, exatamente com estas chaves:',
    '```json',
    JSON.stringify(modelo, null, 2),
    '```',
    '',
    'Regras:',
    '- Tudo em português do Brasil, concreto e realista.',
    ...CAMPOS_PERSONA.map((c) => `- "${c.key}": no máximo ${c.limite} caracteres.`),
    '- Nada de celebridade, pessoa real, marca ou logotipo na roupa, nem estereótipo.',
    '- Não inclua as chaves id nem source.',
  ].join('\n');
}

// ── Leitura da resposta colada ──────────────────────────────────────────────

export function lerRespostaDaPersona(texto: string): { data: Partial<DadosPersona>; ignorados: string[] } {
  const bruto = extrairJson(texto);
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new Error('A resposta precisa ser um objeto JSON, entre chaves { }.');
  const entrada = bruto as Record<string, unknown>;
  const data: Partial<DadosPersona> = {};
  for (const campo of CAMPOS_PERSONA) {
    const valor = entrada[campo.key];
    if (typeof valor === 'string' || typeof valor === 'number') data[campo.key] = String(valor).trim().slice(0, campo.limite);
  }
  const aceitos = Object.keys(data);
  if (aceitos.length === 0) throw new Error('A resposta não tem nenhum campo da persona. Confira se colou a resposta do prompt certo.');
  return { data, ignorados: Object.keys(entrada).filter((k) => !aceitos.includes(k)) };
}
