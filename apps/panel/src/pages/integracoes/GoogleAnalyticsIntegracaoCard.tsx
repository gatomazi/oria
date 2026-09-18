import { useEffect, useState } from 'react';
import { Button, Callout, Card, ConfirmDialog, ErrorState, Select, Skeleton, StatusBadge } from '../../components/ds';
import { formatData } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import {
  desconectarGa, getGaStatus, listGaProperties, salvarGaProperty, urlConectarGa, type GaConnection, type GaProperty,
} from '../../api/googleAnalytics';

// Google Analytics 4 (Fase 2, docs/claude-utm-tracker-ga4.md) — 1 linha por loja, igual à Reserva
// Ink acima. Conectar é navegação de página inteira (OAuth do Google exige top-level navigation,
// não dá pra ser um fetch); ao voltar, a página recarrega e essa lista já reflete o novo status.
function LinhaLoja({ conexao, oauthConfigurado, recarregar }: { conexao: GaConnection; oauthConfigurado: boolean; recarregar: () => void }) {
  const [escolhendo, setEscolhendo] = useState(false);
  const [propriedades, setPropriedades] = useState<GaProperty[] | null>(null);
  const [erroProps, setErroProps] = useState('');
  const [selecionada, setSelecionada] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [confirmandoDesconexao, setConfirmandoDesconexao] = useState(false);

  const temPropriedade = conexao.status === 'connected' && !!conexao.propertyId;
  const precisaEscolherPropriedade = conexao.status === 'connected' && !conexao.propertyId;

  function abrirEscolha() {
    setEscolhendo(true);
    setErroProps('');
    setPropriedades(null);
    listGaProperties()
      .then((d) => {
        setPropriedades(d.propriedades);
        if (d.propriedades[0]) setSelecionada(d.propriedades[0].propertyId);
      })
      .catch((err: Error) => setErroProps(err.message));
  }

  function salvarPropriedade() {
    const p = propriedades?.find((x) => x.propertyId === selecionada);
    if (!p) return;
    setSalvando(true);
    setErroProps('');
    salvarGaProperty(p.propertyId, p.propertyName)
      .then(() => {
        setEscolhendo(false);
        recarregar();
      })
      .catch((err: Error) => setErroProps(err.message))
      .finally(() => setSalvando(false));
  }

  async function confirmarDesconexao() {
    await desconectarGa();
    setConfirmandoDesconexao(false);
    recarregar();
  }

  const tone = temPropriedade ? 'success' : conexao.status === 'error' || conexao.status === 'expired' ? 'danger' : precisaEscolherPropriedade ? 'warning' : 'neutral';
  const label = temPropriedade
    ? 'Conectado'
    : conexao.status === 'error'
      ? 'Erro'
      : conexao.status === 'expired'
        ? 'Expirado'
        : precisaEscolherPropriedade
          ? 'Falta escolher a propriedade'
          : 'Não conectado';

  return (
    <div className="ga-linha">
      <div className="ga-linha__topo">
        <span className="ga-linha__loja">{adminStores.name(conexao.loja)}</span>
        <StatusBadge tone={tone} label={label} />
        {conexao.propertyName && <span className="ga-linha__meta">{conexao.propertyName}</span>}
        {conexao.googleAccountEmail && <span className="ga-linha__meta">{conexao.googleAccountEmail}</span>}
        {conexao.lastSyncAt && <span className="ga-linha__meta">Sincronizado {formatData(conexao.lastSyncAt)}</span>}

        <span className="ga-linha__acao">
          {conexao.status === 'disconnected' || conexao.status === 'error' || conexao.status === 'expired' ? (
            oauthConfigurado ? (
              <a className="ds-btn ds-btn--secondary ds-btn--sm" href={urlConectarGa()}>
                {conexao.status === 'disconnected' ? 'Conectar' : 'Reconectar'}
              </a>
            ) : (
              <Button variant="secondary" size="sm" disabled title="Configure GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_OAUTH_REDIRECT_URI">
                Conectar
              </Button>
            )
          ) : precisaEscolherPropriedade ? (
            <Button variant="secondary" size="sm" onClick={abrirEscolha}>Escolher propriedade</Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={abrirEscolha}>Trocar propriedade</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmandoDesconexao(true)}>Desconectar</Button>
            </>
          )}
        </span>
      </div>

      {conexao.status === 'error' && conexao.lastError && <p className="ga-linha__erro" role="alert">{conexao.lastError}</p>}

      {escolhendo && (
        <div className="ga-linha__form">
          {!propriedades && !erroProps && <span className="pc-nota">Carregando propriedades da conta Google…</span>}
          {erroProps && (
            <p className="ga-linha__erro" role="alert">{erroProps}</p>
          )}
          {propriedades && propriedades.length === 0 && <span className="pc-nota">Nenhuma propriedade GA4 encontrada nessa conta Google.</span>}
          {propriedades && propriedades.length > 0 && (
            <>
              <Select aria-label="Propriedade do Google Analytics" value={selecionada} onChange={(e) => setSelecionada(e.target.value)}>
                {propriedades.map((p) => (
                  <option key={p.propertyId} value={p.propertyId}>
                    {p.propertyName} — {p.accountName}
                  </option>
                ))}
              </Select>
              <Button size="sm" disabled={salvando} onClick={salvarPropriedade}>
                {salvando ? 'Salvando…' : 'Usar esta propriedade'}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => setEscolhendo(false)}>Cancelar</Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmandoDesconexao}
        onClose={() => setConfirmandoDesconexao(false)}
        title={`Desconectar o Google Analytics de ${adminStores.name(conexao.loja)}?`}
        description="As campanhas UTM salvas continuam normalmente — só a performance real por GA4 deixa de aparecer."
        onConfirm={confirmarDesconexao}
      />
    </div>
  );
}

export function GoogleAnalyticsIntegracaoCard() {
  const [dados, setDados] = useState<{ conexoes: GaConnection[]; oauthConfigurado: boolean } | null>(null);
  const [erro, setErro] = useState('');

  function carregar() {
    setErro('');
    getGaStatus()
      .then(setDados)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, []);

  return (
    <Card title="Google Analytics 4" description="Conecte pra ver sessões, compras e receita reais das campanhas UTM salvas no UTM Tracker.">
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton rows={3} />}
      {!erro && dados && (
        <div className="ds-stack">
          {!dados.oauthConfigurado && (
            <Callout tone="warning" title="OAuth do Google não configurado neste ambiente">
              Faltam as variáveis <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> e/ou <code>GOOGLE_OAUTH_REDIRECT_URI</code>.
            </Callout>
          )}
          <div>
            {dados.conexoes.map((c) => (
              <LinhaLoja key={c.loja} conexao={c} oauthConfigurado={dados.oauthConfigurado} recarregar={carregar} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
