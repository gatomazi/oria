// Modo discreto da Visão geral: oculta os VALORES FINANCEIROS da tela (receita, custos, lucro,
// margens, proporções) para quem trabalha com a tela à vista de outras pessoas.
//
// Persistência: só a escolha (oculto/visível), no `localStorage` DESTE navegador, numa chave por
// usuário E por Organization — outra pessoa que entre no mesmo computador não herda a escolha.
// Nada sensível é gravado: nem número, nem nome, nem token. Não sincroniza entre navegadores ou
// dispositivos (não existe preferência de usuário no servidor hoje) — e a tela não promete isso.
//
// Padrão seguro: sem preferência gravada, sem usuário/Organization resolvidos ou com o armazenamento
// indisponível, os valores começam OCULTOS. Se o armazenamento estiver bloqueado, a escolha vale
// enquanto a aba estiver aberta (memória), sem lançar erro.
//
// Isto é privacidade VISUAL: quem tem acesso à conta ou às respostas de rede continua vendo os dados.

export const PREFIXO_MODO_DISCRETO = 'oria.dashboard.valores.v1';

type Leitor = Pick<Storage, 'getItem'>;
type Escritor = Pick<Storage, 'setItem'>;

const armazenamento = (): Storage | null => {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};

// Fallback em memória: armazenamento bloqueado não pode travar o botão.
const memoria = new Map<string, boolean>();

export function chaveModoDiscreto(userId: string | null | undefined, organizationId: string | null | undefined): string | null {
  if (!userId || !organizationId) return null;
  return `${PREFIXO_MODO_DISCRETO}:${userId}:${organizationId}`;
}

// true = ocultar valores. Nunca lança.
export function lerOculto(chave: string | null, fonte: Leitor | null = armazenamento()): boolean {
  if (!chave) return true;
  if (fonte) {
    try {
      const bruto = fonte.getItem(chave);
      if (bruto === 'visivel') return false;
      if (bruto === 'oculto') return true;
    } catch { /* cai na memória / padrão */ }
  }
  return memoria.has(chave) ? (memoria.get(chave) as boolean) : true;
}

export function gravarOculto(chave: string | null, oculto: boolean, destino: Escritor | null = armazenamento()): void {
  if (!chave) return;
  memoria.set(chave, oculto);
  if (!destino) return;
  try { destino.setItem(chave, oculto ? 'oculto' : 'visivel'); } catch { /* preferência é conveniência: fica na memória */ }
}
