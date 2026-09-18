import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon';

type Direcao = 'asc' | 'desc';

// Porte de dataTable() em components.js. Vanilla devolve { el, setRows } (imperativo); em React
// isso vira um componente puro — a página controla `rows` via seu próprio state, sem precisar
// de um método setRows separado.
export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  // Presente = coluna ordenável (header vira clicável). Ausente = comportamento de sempre.
  // Pedido do usuário, 2026-09-06: "filtros de ordenação em cada página, de acordo com as
  // colunas existentes" — a ordenação é uma capacidade do DataTable (1 lugar só), cada página só
  // declara `sortValue` nas colunas que fizerem sentido ordenar.
  sortValue?: (row: T) => string | number | boolean | null | undefined;
  // Aditivos (DESIGN.md › Data Table): números/valores/datas à direita; largura fixa ou mínima;
  // texto longo trunca em 1 linha (o título completo vai no atributo title quando for string).
  align?: 'left' | 'right';
  // Rótulo só pra leitor de tela (ex.: coluna de miniatura sem título visível).
  hideLabel?: boolean;
  // Direção do primeiro clique quando a coluna ainda não está ordenada (datas e valores costumam
  // fazer mais sentido do maior pro menor).
  firstSortDirection?: Direcao;
  width?: number | string;
  truncate?: boolean;
  muted?: boolean;
  // 'low' = coluna de apoio que some abaixo de 600px (DESIGN.md › Data Table › Mobile). O detalhe
  // completo continua no drawer/página da linha; no celular a tabela mostra só o essencial.
  priority?: 'high' | 'low';
}

// Seleção múltipla é aditiva (prop opcional) — páginas que não passam `selection` continuam
// exatamente como antes. `isSelected` recebe a linha (não só a key) pra a página decidir com
// qualquer critério; `onToggleAll` reflete só as linhas da página atual (rows), nunca "todos os
// resultados do filtro" — isso é uma decisão de cada página, fora do componente.
interface SelectionProps<T> {
  isSelected: (row: T) => boolean;
  onToggleRow: (row: T) => void;
  onToggleAll?: (checked: boolean) => void;
  allOnPageSelected?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  rowKey?: (row: T, index: number) => string | number;
  selection?: SelectionProps<T>;
  // Modo compacto opcional (40px) pra tabelas muito densas; padrão é 44px.
  compact?: boolean;
  // Rótulo acessível da tabela (leitor de tela).
  label?: string;
  // Ordenação inicial visível, aplicada nas linhas recebidas (listas carregadas inteiras).
  defaultSort?: { key: string; direction: Direcao };
  // Modo controlado pelo servidor: a tabela NÃO reordena as linhas — só mostra o indicador e avisa
  // a página, que busca de novo já ordenado (listas paginadas no servidor, ex.: Pedidos).
  sort?: TableSort | null;
  onSortChange?: (sort: TableSort) => void;
  // false desliga a ordenação por coluna (lista paginada cuja fonte não sabe ordenar: ordenar só a
  // página visível dá a impressão errada de ordenar o histórico inteiro).
  sortable?: boolean;
}

export interface TableSort {
  key: string;
  direction: Direcao;
}


export function DataTable<T>({
  columns, rows, onRowClick, rowKey, selection, compact, label, defaultSort, sort, onSortChange, sortable = true,
}: DataTableProps<T>) {
  const controlado = !!onSortChange;
  const [ordenacaoLocal, setOrdenacao] = useState<{ key: string; direcao: Direcao } | null>(
    defaultSort ? { key: defaultSort.key, direcao: defaultSort.direction } : null,
  );
  const ordenacao = !sortable ? null : controlado ? (sort ? { key: sort.key, direcao: sort.direction } : null) : ordenacaoLocal;

  const rowsOrdenadas = useMemo(() => {
    if (!ordenacao || controlado) return rows;
    const coluna = columns.find((c) => c.key === ordenacao.key);
    if (!coluna?.sortValue) return rows;
    const sortValue = coluna.sortValue;
    const sinal = ordenacao.direcao === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const va = sortValue(a);
      const vb = sortValue(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // nulo sempre no fim, nas duas direções
      if (vb == null) return -1;
      if (va < vb) return -1 * sinal;
      if (va > vb) return 1 * sinal;
      return 0;
    });
  }, [rows, ordenacao, columns, controlado]);

  function alternarOrdenacao(col: Column<T>) {
    if (!col.sortValue || !sortable) return;
    if (controlado) {
      const ativa = ordenacao?.key === col.key;
      const direction: Direcao = ativa ? (ordenacao!.direcao === 'asc' ? 'desc' : 'asc') : col.firstSortDirection ?? 'asc';
      onSortChange!({ key: col.key, direction });
      return;
    }
    setOrdenacao((atual) => {
      if (!atual || atual.key !== col.key) return { key: col.key, direcao: 'asc' };
      if (atual.direcao === 'asc') return { key: col.key, direcao: 'desc' };
      return null; // 3º clique volta pra ordem original
    });
  }

  return (
    <div className="ds-table-wrap">
      <table className={'ds-table' + (compact ? ' ds-table--compact' : '')} aria-label={label}>
        <thead>
          <tr>
            {selection && (
              <th className="ds-table__th--checkbox" scope="col">
                {selection.onToggleAll && (
                  <input
                    type="checkbox"
                    checked={!!selection.allOnPageSelected}
                    onChange={(e) => selection.onToggleAll!(e.target.checked)}
                    aria-label="Selecionar todos nesta página"
                  />
                )}
              </th>
            )}
            {columns.map((col) => {
              const ativa = ordenacao?.key === col.key;
              const ordenavel = sortable && !!col.sortValue;
              const classes = [ordenavel ? 'ds-table__th--ordenavel' : null, col.align === 'right' ? 'ds-table__cell--right' : null, col.priority === 'low' ? 'ds-table__cell--low' : null]
                .filter(Boolean)
                .join(' ');
              return (
                <th
                  key={col.key}
                  scope="col"
                  className={classes || undefined}
                  style={col.width != null ? { width: col.width } : undefined}
                  onClick={ordenavel ? () => alternarOrdenacao(col) : undefined}
                  onKeyDown={
                    ordenavel
                      ? (e: KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            alternarOrdenacao(col);
                          }
                        }
                      : undefined
                  }
                  tabIndex={ordenavel ? 0 : undefined}
                  aria-sort={ativa ? (ordenacao!.direcao === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="ds-table__th-inner">
                    {col.hideLabel || !col.label ? <span className="ds-sr-only">{col.label || (col.key === 'img' ? 'Imagem' : 'Ações')}</span> : col.label}
                    {ordenavel && (
                      <span className="ds-table__sort-icon">
                        <Icon name={ativa ? (ordenacao!.direcao === 'asc' ? 'sort-asc' : 'sort-desc') : 'sort-both'} size={14} />
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rowsOrdenadas.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              data-clickable={onRowClick ? '' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              // Linha clicável também abre pelo teclado (Enter/Espaço), sem roubar o clique de botões internos.
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e: KeyboardEvent) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {selection && (
                <td className="ds-table__td--checkbox" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selection.isSelected(row)}
                    onChange={() => selection.onToggleRow(row)}
                    aria-label="Selecionar linha"
                  />
                </td>
              )}
              {columns.map((col) => {
                const content = col.render ? col.render(row) : ((row as Record<string, ReactNode>)[col.key]);
                const value = content == null ? '—' : content;
                const classes = [col.align === 'right' ? 'ds-table__cell--right' : null, col.muted ? 'ds-table__cell--muted' : null, col.priority === 'low' ? 'ds-table__cell--low' : null]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <td key={col.key} className={classes || undefined} style={col.width != null && col.truncate ? { maxWidth: col.width } : undefined}>
                    {col.truncate ? (
                      <span className="ds-table__truncate" title={typeof value === 'string' ? value : undefined}>
                        {value}
                      </span>
                    ) : (
                      value
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
