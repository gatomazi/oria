import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, Card, EmptyState, ErrorState, Skeleton, TabList } from '../../components/ds';
import { formatValor, plural } from '../../lib/format';
import { getDashboardLucroProdutos, type AgrupamentoLucro, type DashboardLucroProdutosData } from '../../api/dashboard';
import { useModoDiscreto, ValorOculto } from './ModoDiscreto';

import '../../analytics.css';

const VISIVEIS_INICIAL = 10;

// Ranking de lucro bruto por produto ou por modelo de peça no período (pedidos pagos, sem troca).
// "Lucro bruto" = venda − desconto rateado − custo de produção, ANTES da mídia e das despesas (campo
// lucro_operacional do servidor; o rótulo antigo dizia "operacional", o que sugeria descontar mídia).
// Modo discreto: valores, lucro por peça e barras (proporcionais ao lucro) saem, e a ordem passa a
// ser por peças — manter a ordem por lucro revelaria o ranking financeiro. Lista com barra e não DataTable: a comparação entre as linhas é a leitura principal. A
// barra é relativa ao 1º colocado; o rótulo acessível diz a fatia do lucro total.
export function LucroProdutosCard({ startDate, endDate, escopo, rotuloPeriodo }: { startDate: string; endDate: string; escopo: string; rotuloPeriodo: string }) {
  const [agrupar, setAgrupar] = useState<AgrupamentoLucro>('produto');
  const [dados, setDados] = useState<DashboardLucroProdutosData | null>(null);
  const [erro, setErro] = useState('');
  const [mostrarTodos, setMostrarTodos] = useState(false);

  useEffect(() => {
    let ativo = true;
    setDados(null);
    setErro('');
    setMostrarTodos(false);
    getDashboardLucroProdutos({ startDate, endDate }, agrupar)
      .then((d) => { if (ativo) setDados(d); })
      .catch((err: Error) => { if (ativo) setErro(err.message); });
    return () => { ativo = false; };
  }, [startDate, endDate, escopo, agrupar]);

  const { oculto } = useModoDiscreto();
  const itensBrutos = dados?.itens || [];
  const itens = oculto ? [...itensBrutos].sort((a, b) => b.pecas - a.pecas) : itensBrutos;
  const lucroTotal = itens.reduce((acc, i) => acc + Math.max(i.lucroOperacional, 0), 0);
  const maiorLucro = Math.max(...itens.map((i) => i.lucroOperacional), 0);
  const visiveis = mostrarTodos ? itens : itens.slice(0, VISIVEIS_INICIAL);

  return (
    <Card
      title={`${oculto ? 'Peças' : 'Lucro bruto'} por ${agrupar === 'produto' ? 'produto' : 'modelo'} — ${rotuloPeriodo}`}
      action={
        <TabList
          label="Agrupar lucro por"
          value={agrupar}
          onChange={setAgrupar}
          items={[
            { value: 'produto', label: 'Produto' },
            { value: 'modelo', label: 'Modelo' },
          ]}
        />
      }
    >
      {erro ? (
        <ErrorState description={erro} />
      ) : !dados ? (
        <Skeleton rows={5} />
      ) : (
        <div className="ds-stack">
          {dados.pedidosSemItens > 0 && (
            <Callout
              tone="warning"
              title={`${plural(dados.pedidosSemItens, 'pedido pago', 'pedidos pagos')} do período ainda sem itens gravados`}
              action={
                <Link className="ds-btn ds-btn--secondary ds-btn--sm" to="/admin/integracoes">
                  Rodar backfill
                </Link>
              }
            >
              Ficam fora deste ranking até o sync de hora em hora ou o backfill de pedidos passar por eles.
            </Callout>
          )}
          {!itens.length ? (
            <EmptyState title="Sem vendas pagas com itens neste período" />
          ) : (
            <div>
              <div className="ga-lista__cabecalho" aria-hidden="true">
                <span>{agrupar === 'produto' ? 'Produto' : 'Modelo'}</span>
                <span>Participação</span>
                <span>Peças</span>
                <span className="ga-lista__metrica--opcional">Lucro/peça</span>
                <span>Lucro bruto</span>
              </div>
              <ul className="ga-lista">
                {visiveis.map((item) => {
                  const nome = item.nome || 'Sem nome';
                  const fatia = lucroTotal > 0 ? Math.max(item.lucroOperacional, 0) / lucroTotal : 0;
                  const escala = maiorLucro > 0 ? Math.max(item.lucroOperacional, 0) / maiorLucro : 0;
                  return (
                    <li className="ga-lista__item" key={item.chave}>
                      <span className="ga-lista__nome" title={nome}>{nome}</span>
                      {oculto ? (
                        <span className="ga-barra ga-barra--oculta" aria-hidden="true" />
                      ) : (
                        <span className="ga-barra" role="img" aria-label={`${Math.round(fatia * 100)}% do lucro bruto`}>
                          <span className="ga-barra__preenchimento ga-barra__preenchimento--sucesso" style={{ transform: `scaleX(${escala})` }} />
                        </span>
                      )}
                      <span className="ga-lista__metrica">{item.pecas.toLocaleString('pt-BR')}</span>
                      <span className="ga-lista__metrica ga-lista__metrica--opcional">
                        {oculto ? <ValorOculto /> : item.pecas > 0 ? formatValor(item.lucroOperacional / item.pecas) : '—'}
                      </span>
                      <span className="ga-lista__metrica">
                        {oculto ? <ValorOculto /> : <strong>{formatValor(item.lucroOperacional)}</strong>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {itens.length > VISIVEIS_INICIAL && (
                <Button variant="ghost" size="sm" onClick={() => setMostrarTodos((v) => !v)}>
                  {mostrarTodos ? 'Mostrar menos' : `Mostrar todos (${itens.length})`}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
