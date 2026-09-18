import { useEffect, useRef, useState } from 'react';
import { Button, Callout, Card, ConfirmDialog, ErrorState, RadioCardGroup, Skeleton, StatusBadge,  } from '../../components/ds';
import { formatData, plural } from '../../lib/format';
import {
  atribuirLojaGoogleAds, desconectarGoogleAds, getGoogleAdsStatus, listarGoogleAdsContas, mensagemErroGoogleAds,
  selecionarGoogleAdsConta, sincronizarGoogleAdsAgora, urlConectarGoogleAds,
  type GoogleAdsAvisoConta, type GoogleAdsConta, type GoogleAdsStatus,
} from '../../api/googleAds';

// Conta de administrador (MCC) não veicula anúncio e nunca terá métrica; conta de teste só existe
// no sandbox. As duas continuam na lista — esconder faria o usuário procurar por uma conta que ele
// sabe que existe — mas a tela avisa em vez de deixar ele escolher no escuro e ver zeros depois.
function descricaoConta(conta: GoogleAdsConta): string {
  const partes = [
    conta.customerIdFormatado || conta.customerId,
    conta.moeda,
    conta.fuso,
    conta.manager ? 'Conta de administrador — não veicula anúncios' : null,
    conta.teste ? 'Conta de teste' : null,
  ].filter(Boolean);
  return partes.join(' · ');
}

export function GoogleAdsIntegracaoCard() {
  const [dados, setDados] = useState<GoogleAdsStatus | null>(null);
  const [erro, setErro] = useState('');
  const [erroAcao, setErroAcao] = useState('');
  const [escolhendo, setEscolhendo] = useState(false);
  const [contaEscolhida, setContaEscolhida] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [salvandoLoja, setSalvandoLoja] = useState(false);
  const [atualizandoContas, setAtualizandoContas] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [confirmandoDesconexao, setConfirmandoDesconexao] = useState(false);
  // Contas que a API listou mas cujo nome/moeda não vieram. Sem mostrar isso, a lista aparece com
  // o ID pelado e o usuário não tem como saber que algo falhou.
  const [avisos, setAvisos] = useState<GoogleAdsAvisoConta[]>([]);

  function carregar() {
    return getGoogleAdsStatus()
      .then((d) => { setDados(d); setErro(''); syncAtivo.current = !!d.syncEmAndamento; return d; })
      .catch((err: Error) => { setErro(err.message); return null; });
  }

  // Sem ref, o setInterval capturaria o `dados` do primeiro render e nunca pararia de pollar.
  const syncAtivo = useRef(false);

  useEffect(() => {
    carregar();
    const t = setInterval(() => { if (syncAtivo.current) carregar(); }, 5000);
    return () => clearInterval(t);
  }, []);

  function conectar() {
    setErroAcao('');
    urlConectarGoogleAds()
      .then((r) => { window.location.href = r.url; })
      .catch((err: Error) => setErroAcao(err.message));
  }

  function atualizarContas() {
    setAtualizandoContas(true);
    setErroAcao('');
    listarGoogleAdsContas()
      .then((r) => { setAvisos(r.avisos || []); return carregar(); })
      .catch((err: Error) => setErroAcao(mensagemErroGoogleAds(null, err.message)))
      .finally(() => setAtualizandoContas(false));
  }

  function salvarConta() {
    if (!contaEscolhida) return;
    setSalvando(true);
    setErroAcao('');
    selecionarGoogleAdsConta(contaEscolhida)
      .then(() => { setEscolhendo(false); return carregar(); })
      .catch((err: Error) => setErroAcao(err.message))
      .finally(() => setSalvando(false));
  }

  function sincronizar() {
    setSincronizando(true);
    setErroAcao('');
    sincronizarGoogleAdsAgora()
      .catch((err: Error) => setErroAcao(mensagemErroGoogleAds(null, err.message)))
      // Recarrega mesmo quando falha: o erro real fica guardado na conexão, e sem este carregar()
      // a tela continuava mostrando o estado velho e escondia o diagnóstico.
      .finally(() => { setSincronizando(false); syncAtivo.current = true; carregar(); });
  }

  function desconectar() {
    desconectarGoogleAds()
      .then(() => { setConfirmandoDesconexao(false); return carregar(); })
      .catch((err: Error) => setErroAcao(err.message));
  }

  if (erro) return <Card title="Google Ads"><ErrorState description={erro} onRetry={carregar} /></Card>;
  if (!dados) return <Card title="Google Ads"><Skeleton rows={3} /></Card>;

  const contaAtiva = dados.contas.find((c) => c.selecionada) || null;
  // Erro tem precedência sobre ter conta selecionada: mostrar "Conectado" logo acima de "sua
  // conexão expirou" foi um bug real da tela do Meta.
  const emErro = dados.status === 'error' || !!dados.erroCodigo;

  return (
    <Card
      title="Google Ads"
      action={
        dados.conectado && !emErro ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirmandoDesconexao(true)}>Desconectar</Button>
        ) : undefined
      }
    >
      {!dados.oauthConfigurado && (
        <Callout tone="warning" title="OAuth do Google não configurado neste ambiente">
          Faltam as variáveis <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> e{' '}
          <code>GOOGLE_OAUTH_REDIRECT_URI</code>.
        </Callout>
      )}

      <p className="ds-card__status">
        <StatusBadge
          tone={emErro ? 'danger' : dados.conectado ? 'success' : 'neutral'}
          label={emErro ? 'Com problema' : dados.conectado ? 'Conectado' : 'Não conectado'}
        />
        {dados.email && <span className="pc-nota"> {dados.email}</span>}
      </p>

      {emErro && (
        <Callout tone="danger" title="A última sincronização falhou">
          {mensagemErroGoogleAds(dados.erroCodigo, dados.erroMensagem)}
          {/* A frase crua do Google fica visível: esta é uma tela de administrador, e num erro de
              consulta é ela que diz qual campo foi recusado. Sem isso o defeito só é diagnosticável
              com acesso ao log do servidor. */}
          {dados.erroMensagem && (
            <p className="pc-nota"><code>{dados.erroMensagem}</code></p>
          )}
        </Callout>
      )}

      {!dados.conectado && dados.oauthConfigurado && (
        <>
          {/* O escopo do Google Ads concede escrita porque não existe versão só de leitura — dizer
              isso aqui evita o susto de ver "editar, criar e excluir" na tela do Google e desistir. */}
          <Callout tone="info" title="Somente leitura">
            O painel apenas lê o desempenho das campanhas. A tela do Google vai dizer “ver, editar,
            criar e excluir” porque esse é o único escopo que a API do Google Ads oferece — não
            existe versão somente leitura. O Oria não cria, não pausa e não edita nada.
          </Callout>
          <Button onClick={conectar}>Conectar Google Ads</Button>
        </>
      )}

      {dados.conectado && (
        <>
          {contaAtiva ? (
            <div className="ds-stack">
              <p>
                <strong>{contaAtiva.nome || contaAtiva.customerIdFormatado}</strong>
                <span className="pc-nota"> · {descricaoConta(contaAtiva)}</span>
              </p>
              {!contaAtiva.lojaAtribuida && (
                <Callout tone="warning" title="Sem loja atribuída">
                  Enquanto esta conta não estiver ligada a uma loja, o gasto dela fica de fora do
                  resultado consolidado — comparar com a receita de uma loja que ela não atende
                  distorceria a conta.
                  {/* O aviso resolve o problema que aponta: antes era preciso passar por "Trocar
                      conta" só para escolher a loja. */}
                  <div className="ga-linha__acao">
                    <Button
                      size="sm"
                      disabled={salvandoLoja}
                      onClick={() => {
                        setSalvandoLoja(true);
                        setErroAcao('');
                        atribuirLojaGoogleAds(contaAtiva.customerId)
                          .then(carregar)
                          .catch((err: Error) => setErroAcao(err.message))
                          .finally(() => setSalvandoLoja(false));
                      }}
                    >
                      {salvandoLoja ? 'Salvando…' : 'Vincular à loja'}
                    </Button>
                  </div>
                </Callout>
              )}
              <p className="pc-nota">
                {dados.ultimoSync ? `Última sincronização: ${formatData(dados.ultimoSync)}` : 'Ainda não sincronizado'}
              </p>
              <div className="ga-linha__acao">
                <Button variant="secondary" size="sm" disabled={sincronizando || !!dados.syncEmAndamento} onClick={sincronizar}>
                  {sincronizando || dados.syncEmAndamento ? 'Sincronizando…' : 'Sincronizar agora'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setEscolhendo(true); setContaEscolhida(contaAtiva.customerId); }}>
                  Trocar conta
                </Button>
              </div>
            </div>
          ) : (
            <Callout tone="info" title="Escolha a conta de anúncios">
              <div className="ga-linha__acao">
                <Button size="sm" onClick={() => setEscolhendo(true)}>Escolher conta</Button>
                <Button variant="ghost" size="sm" disabled={atualizandoContas} onClick={atualizarContas}>
                  {atualizandoContas ? 'Buscando…' : 'Buscar contas'}
                </Button>
              </div>
            </Callout>
          )}

          {escolhendo && (
            <div className="ds-stack">
              {dados.contas.length === 0 ? (
                <Callout tone="warning" title="Nenhuma conta encontrada">
                  A conta Google conectada não enxerga nenhuma conta de anúncios.
                  <Button variant="ghost" size="sm" disabled={atualizandoContas} onClick={atualizarContas}>
                    {atualizandoContas ? 'Buscando…' : 'Buscar de novo'}
                  </Button>
                </Callout>
              ) : (
                <>
                  <RadioCardGroup
                    name="google-ads-conta"
                    legend="Conta de anúncios"
                    value={contaEscolhida}
                    onChange={setContaEscolhida}
                    options={dados.contas.map((c) => ({
                      value: c.customerId,
                      title: c.nome || c.customerIdFormatado || c.customerId,
                      description: descricaoConta(c),
                    }))}
                  />
                  {/* Sem loja atribuída o gasto não entra no consolidado: o MER divide receita REAL
                      da loja por gasto REAL da conta, e cruzar conta com loja errada infla o número. */}
                  <div className="ga-linha__acao">
                    <Button disabled={!contaEscolhida || salvando} onClick={salvarConta}>
                      {salvando ? 'Salvando…' : 'Usar esta conta'}
                    </Button>
                    <Button variant="ghost" onClick={() => setEscolhendo(false)}>Cancelar</Button>
                  </div>
                </>
              )}
            </div>
          )}

          {dados.contas.length > 0 && !escolhendo && (
            <p className="pc-nota">
              {plural(dados.contas.length, 'conta visível', 'contas visíveis')} nesta conexão.
            </p>
          )}
        </>
      )}

      {avisos.length > 0 && (
        <Callout tone="warning" title={`${plural(avisos.length, 'conta veio', 'contas vieram')} sem nome`}>
          O Google listou {avisos.length === 1 ? 'esta conta' : 'estas contas'} mas recusou os
          detalhes dela{avisos.length === 1 ? '' : 's'}. Dá para selecionar mesmo assim — o que
          identifica a conta na API é o número, não o nome.
          <ul>
            {avisos.map((a) => (
              <li key={a.customerId}>
                <strong>{a.customerId}</strong> — {mensagemErroGoogleAds(a.codigo, a.mensagem)}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {erroAcao && <p className="ds-form-error" role="alert">{erroAcao}</p>}

      <ConfirmDialog
        open={confirmandoDesconexao}
        onClose={() => setConfirmandoDesconexao(false)}
        title="Desconectar o Google Ads?"
        description="O painel para de sincronizar e a permissão é revogada na sua conta Google. Os dados já sincronizados continuam no painel."
        onConfirm={desconectar}
      />
    </Card>
  );
}
