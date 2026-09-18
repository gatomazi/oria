import { formatNumero, formatPercentual, formatReais } from '../../lib/ga4';
import type { GaOverviewGrupo } from '../../api/googleAnalytics';

// Lista canal/dispositivo: nome, barra de participação, sessões, pedidos, receita. Uma lista e não
// uma DataTable porque a barra é o dado principal aqui — a comparação relativa entre as linhas é a
// leitura, e o número exato vem logo depois.
export function ListaGrupoGa4({ itens, rotuloColuna }: { itens: GaOverviewGrupo[]; rotuloColuna: string }) {
  return (
    <div>
      <div className="ga-lista__cabecalho" aria-hidden="true">
        <span>{rotuloColuna}</span>
        <span>Participação</span>
        <span>Sessões</span>
        <span className="ga-lista__metrica--opcional">Pedidos</span>
        <span>Receita</span>
      </div>
      <ul className="ga-lista">
        {itens.map((item) => (
          <li className="ga-lista__item" key={item.rotulo}>
            <span className="ga-lista__nome" title={item.rotulo}>{item.rotulo}</span>
            <span className="ga-barra" role="img" aria-label={`${formatPercentual(item.participacao)} das sessões`}>
              <span className="ga-barra__preenchimento" style={{ transform: `scaleX(${item.participacao})` }} />
            </span>
            <span className="ga-lista__metrica">
              <strong>{formatNumero(item.sessions)}</strong>
            </span>
            <span className="ga-lista__metrica ga-lista__metrica--opcional">{formatNumero(item.purchases)}</span>
            <span className="ga-lista__metrica">{formatReais(item.revenue)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
