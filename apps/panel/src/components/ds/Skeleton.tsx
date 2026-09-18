// Carregamento com a forma do conteúdo (DESIGN.md › States): `lines` pra blocos de texto e
// formulários, `table` pra listas (cabeçalho + linhas de 44px com colunas de larguras variadas),
// assim a página não "pula" quando o dado chega.
interface SkeletonProps {
  rows?: number;
  height?: string;
  width?: string;
  variant?: 'lines' | 'table';
}

const LARGURAS_COLUNA = ['38%', '14%', '18%', '12%'];

export function Skeleton({ rows = 3, height = '16px', width = '100%', variant = 'lines' }: SkeletonProps) {
  if (variant === 'table') {
    return (
      <div className="ds-skeleton-table" role="status" aria-busy="true">
        <span className="ds-sr-only">Carregando</span>
        <div className="ds-skeleton-table__head">
          {LARGURAS_COLUNA.map((w, i) => (
            <span key={i} className="ds-skeleton" style={{ width: `calc(${w} * 0.5)`, height: '10px' }} />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="ds-skeleton-table__row">
            {LARGURAS_COLUNA.map((w, j) => (
              <span key={j} className="ds-skeleton" style={{ width: `calc(${w} * ${j === 0 ? 0.55 + ((i * 7) % 4) * 0.1 : 0.7})`, height: '12px' }} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="ds-skeleton-stack" role="status" aria-busy="true">
      <span className="ds-sr-only">Carregando</span>
      {Array.from({ length: rows }).map((_, i) => (
        <span key={i} className="ds-skeleton" style={{ height, width }} />
      ))}
    </div>
  );
}
