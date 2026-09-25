// Preferências LOCAIS da navegação (sidebar recolhida e grupos fechados). Só conveniência do visualizador: ficam no navegador
// (`localStorage`, chave versionada), nunca vão ao servidor e não carregam nada sensível (só rótulos de grupo de `nav.ts`).
// Qualquer falha de leitura/gravação (janela privada, dado corrompido, armazenamento bloqueado) cai no padrão — a tela funciona igual.

export const CHAVE_NAV_PREFS = 'oria.shell.nav.v1';

export interface NavPrefs {
  colapsada: boolean; // desktop: sidebar reduzida a ícones (o drawer do mobile nunca usa isto)
  gruposFechados: string[]; // rótulos de grupo recolhidos pelo usuário; o padrão é tudo aberto
}

export const NAV_PREFS_PADRAO: NavPrefs = Object.freeze({ colapsada: false, gruposFechados: [] }) as NavPrefs;

type Leitor = Pick<Storage, 'getItem'>;
type Escritor = Pick<Storage, 'setItem'>;

const armazenamento = (): Storage | null => {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
};

// Aceita só a forma conhecida; descarta o resto (nunca lança).
export function lerPrefs(fonte: Leitor | null = armazenamento()): NavPrefs {
  if (!fonte) return { colapsada: false, gruposFechados: [] };
  try {
    const bruto = fonte.getItem(CHAVE_NAV_PREFS);
    if (!bruto) return { colapsada: false, gruposFechados: [] };
    const j = JSON.parse(bruto) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { colapsada: false, gruposFechados: [] };
    const o = j as Record<string, unknown>;
    const fechados = Array.isArray(o.gruposFechados)
      ? Array.from(new Set(o.gruposFechados.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80))).slice(0, 40)
      : [];
    return { colapsada: o.colapsada === true, gruposFechados: fechados };
  } catch {
    return { colapsada: false, gruposFechados: [] };
  }
}

export function gravarPrefs(prefs: NavPrefs, destino: Escritor | null = armazenamento()): void {
  if (!destino) return;
  try { destino.setItem(CHAVE_NAV_PREFS, JSON.stringify({ colapsada: prefs.colapsada, gruposFechados: prefs.gruposFechados })); } catch { /* preferência é só conveniência */ }
}

export const alternarColapso = (p: NavPrefs): NavPrefs => ({ ...p, colapsada: !p.colapsada });

export const alternarGrupo = (p: NavPrefs, rotulo: string): NavPrefs => ({
  ...p,
  gruposFechados: p.gruposFechados.includes(rotulo) ? p.gruposFechados.filter((g) => g !== rotulo) : [...p.gruposFechados, rotulo],
});

export const grupoAberto = (p: NavPrefs, rotulo: string): boolean => !p.gruposFechados.includes(rotulo);

// Itens de um grupo que aparecem na sidebar EXPANDIDA: grupo aberto → todos; grupo fechado → só o item da página atual (orientação:
// quem está numa página sempre vê onde está). Na sidebar reduzida (só ícones) os grupos fechados não se aplicam: todo item continua
// alcançável.
export function itensVisiveis<T extends { key: string }>(itens: T[], aberto: boolean, chaveAtiva: string, reduzida: boolean): T[] {
  if (aberto || reduzida) return itens;
  return itens.filter((i) => i.key === chaveAtiva);
}
