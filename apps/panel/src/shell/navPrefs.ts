// Preferências da navegação. Só a sidebar recolhida (trilho de ícones) é lembrada entre visitas — conveniência do visualizador, no navegador
// (`localStorage`, chave versionada), nunca no servidor e sem nada sensível. Os grupos do menu NÃO são lembrados: todo carregamento do painel
// começa com todos fechados (só o item da página atual aparece) e abrir um grupo vale enquanto o painel está aberto.
// Qualquer falha de leitura/gravação (janela privada, dado corrompido, armazenamento bloqueado) cai no padrão — a tela funciona igual.

export const CHAVE_NAV_PREFS = 'oria.shell.nav.v1';

export interface NavPrefs {
  colapsada: boolean; // desktop: sidebar reduzida a ícones (o drawer do mobile nunca usa isto)
  gruposAbertos: string[]; // rótulos de grupo abertos nesta sessão (não persiste); o padrão é tudo fechado
}

export const NAV_PREFS_PADRAO: NavPrefs = Object.freeze({ colapsada: false, gruposAbertos: [] }) as NavPrefs;

type Leitor = Pick<Storage, 'getItem'>;
type Escritor = Pick<Storage, 'setItem'>;

const armazenamento = (): Storage | null => {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};

// Lê só `colapsada`; descarta o resto (inclusive o antigo `gruposFechados`). Nunca lança. Grupos sempre começam fechados.
export function lerPrefs(fonte: Leitor | null = armazenamento()): NavPrefs {
  const padrao = { colapsada: false, gruposAbertos: [] as string[] };
  if (!fonte) return padrao;
  try {
    const bruto = fonte.getItem(CHAVE_NAV_PREFS);
    if (!bruto) return padrao;
    const j = JSON.parse(bruto) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return padrao;
    return { colapsada: (j as Record<string, unknown>).colapsada === true, gruposAbertos: [] };
  } catch {
    return padrao;
  }
}

export function gravarPrefs(prefs: NavPrefs, destino: Escritor | null = armazenamento()): void {
  if (!destino) return;
  try { destino.setItem(CHAVE_NAV_PREFS, JSON.stringify({ colapsada: prefs.colapsada })); } catch { /* preferência é só conveniência */ }
}

export const alternarColapso = (p: NavPrefs): NavPrefs => ({ ...p, colapsada: !p.colapsada });

export const alternarGrupo = (p: NavPrefs, rotulo: string): NavPrefs => ({
  ...p,
  gruposAbertos: p.gruposAbertos.includes(rotulo) ? p.gruposAbertos.filter((g) => g !== rotulo) : [...p.gruposAbertos, rotulo],
});

export const grupoAberto = (p: NavPrefs, rotulo: string): boolean => p.gruposAbertos.includes(rotulo);

// Itens de um grupo que aparecem na sidebar EXPANDIDA: grupo aberto → todos; grupo fechado → só o item da página atual (orientação:
// quem está numa página sempre vê onde está). Na sidebar reduzida (só ícones) os grupos fechados não se aplicam: todo item continua
// alcançável.
export function itensVisiveis<T extends { key: string }>(itens: T[], aberto: boolean, chaveAtiva: string, reduzida: boolean): T[] {
  if (aberto || reduzida) return itens;
  return itens.filter((i) => i.key === chaveAtiva);
}
