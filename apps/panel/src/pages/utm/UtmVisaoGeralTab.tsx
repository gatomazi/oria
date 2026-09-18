import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, EmptyState, ErrorState, KpiCard, KpiStrip, Skeleton } from '../../components/ds';
import { formatData, plural } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import { listUtmCampaigns, type UtmCampaign } from '../../api/utm';
import { getGaStatus } from '../../api/googleAnalytics';

// Sem GA4 conectado (ou conectado sem propriedade escolhida), a Visão geral mostra só o que
// existe de verdade: campanhas salvas e links gerados (spec, Parte 19). Nenhum número de
// sessão/receita é inventado — a Fase 3 (Data API/performance) ainda não foi construída, mesmo
// depois de conectar (Fase 2).
export function UtmVisaoGeralTab({ onIrParaCampanhas, onIrParaConstrutor, onIrParaPerformance }: {
  onIrParaCampanhas: () => void; onIrParaConstrutor: () => void; onIrParaPerformance: () => void;
}) {
  const [campanhas, setCampanhas] = useState<UtmCampaign[] | null>(null);
  const [erro, setErro] = useState('');
  const [algumaLojaConectada, setAlgumaLojaConectada] = useState(false);

  function carregar() {
    setErro('');
    listUtmCampaigns({ status: 'todas' })
      .then((data) => setCampanhas(data.campanhas))
      .catch((err: Error) => setErro(err.message));
    getGaStatus()
      .then((d) => setAlgumaLojaConectada(d.conexoes.some((c) => c.status === 'connected' && c.propertyId)))
      .catch(() => setAlgumaLojaConectada(false));
  }

  useEffect(carregar, []);

  if (erro) return <ErrorState description={erro} onRetry={carregar} />;
  if (!campanhas) {
    return (
      <div className="ds-stack">
        <Skeleton rows={1} height="88px" />
        <Skeleton variant="table" rows={4} />
      </div>
    );
  }

  const ativas = campanhas.filter((c) => !c.arquivadaEm);
  const arquivadas = campanhas.length - ativas.length;
  const lojasComCampanha = new Set(ativas.map((c) => c.loja)).size;
  const recentes = ativas.slice(0, 5);

  return (
    <div className="ds-stack">
      <KpiStrip label="Resumo do UTM Tracker">
        <KpiCard title="Campanhas ativas" value={ativas.length} />
        <KpiCard title="Arquivadas" value={arquivadas} />
        <KpiCard title="Lojas com campanha" value={lojasComCampanha} />
      </KpiStrip>

      <Callout
        tone="info"
        title={algumaLojaConectada ? 'Performance real disponível' : 'Sem Google Analytics conectado ainda'}
        action={algumaLojaConectada
          ? <Button variant="secondary" size="sm" onClick={onIrParaPerformance}>Ver performance</Button>
          : <Link className="ds-btn ds-btn--secondary ds-btn--sm" to="/admin/integracoes">Conectar GA4</Link>}
      >
        {algumaLojaConectada
          ? 'Sessões, usuários, compras e receita por combinação de UTM — inclusive links usados fora do Construtor — estão na aba Performance.'
          : 'Sessões, compras e receita por campanha aparecem aqui depois que o GA4 for conectado em Integrações. Até lá, o Builder continua funcionando normalmente — nada de número inventado nesta tela.'}
      </Callout>

      <div className="ds-stack">
        <div className="utm-secao-cabecalho">
          <span className="ds-status-linha__meta">Campanhas recentes</span>
          <Button variant="ghost" size="sm" onClick={onIrParaCampanhas}>Ver todas</Button>
        </div>
        {recentes.length === 0 ? (
          <EmptyState title="Nenhuma campanha ainda" description="Monte a primeira URL no Construtor e salve pra ela aparecer aqui." action={<Button variant="secondary" onClick={onIrParaConstrutor}>Ir pro Construtor</Button>} />
        ) : (
          <div className="utm-preset-lista">
            {recentes.map((c) => (
              <div className="utm-preset-row" key={c.id}>
                <span className="utm-preset-row__nome">{c.nome}</span>
                <span className="utm-preset-row__combo">
                  <code>{adminStores.name(c.loja)}</code>
                  <code>{c.source}</code>
                  <code>{c.medium}</code>
                </span>
                <span className="ds-status-linha__meta">{formatData(c.atualizadoEm)}</span>
              </div>
            ))}
          </div>
        )}
        {ativas.length > 0 && <p className="pc-nota">{plural(ativas.length, 'campanha ativa', 'campanhas ativas')} no total.</p>}
      </div>
    </div>
  );
}
