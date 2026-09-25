import { useEffect, useRef, useState } from 'react';
import { Button, Callout, ConfirmDialog, ErrorState, RadioCardGroup, Skeleton, StatusBadge } from '../../components/ds';
import { Secao, useAtualizarResumo, useEhOwner } from './IntegracaoAcordeao';
import { formatData, formatDiaISO, idadeDoCache, plural } from '../../lib/format';
import {
  contaEstaAtiva, definirLojaDaContaMeta, desconectarMeta, getMetaStatus, listarMetaContas, mascararContaMeta, mensagemErroMeta,
  META_ACCOUNT_STATUS, selecionarMetaConta, sincronizarMetaAgora, urlConectarMeta,
  type MetaConta, type MetaSincronizacao, type MetaStatus,
} from '../../api/metaAds';

// Enquanto a importação roda, o status é a única forma de saber onde ela está — o backend responde
// antes de terminar (spec §32: não bloquear a requisição HTTP). 8s é frequente o bastante pra tela
// parecer viva e raro o bastante pra não martelar o servidor.
const INTERVALO_POLL_MS = 8000;

function rotuloSync(s: MetaSincronizacao): string {
  const tipos: Record<MetaSincronizacao['tipo'], string> = {
    INITIAL_IMPORT: 'Importação inicial',
    INCREMENTAL: 'Sincronização automática',
    BACKFILL: 'Revisão de atribuição',
    MANUAL: 'Sincronização manual',
  };
  return tipos[s.tipo] || s.tipo;
}

// A conta desativada continua na lista de propósito: escondê-la faria o usuário procurar por uma
// conta que ele sabe que existe. Aparece com o motivo, e é o único caso em que a tela desencoraja
// a escolha sem impedi-la — quem manda é quem conhece a operação.
function descricaoConta(conta: MetaConta) {
  const partes = [
    conta.metaAccountId,
    conta.currency,
    conta.timezoneName,
    conta.accountStatus != null && !contaEstaAtiva(conta)
      ? (META_ACCOUNT_STATUS[conta.accountStatus] || `Status ${conta.accountStatus}`)
      : null,
  ].filter(Boolean);
  return partes.join(' · ');
}

export function MetaAdsIntegracaoCard() {
  const atualizarResumo = useAtualizarResumo();
  const ehOwner = useEhOwner();
  const [dados, setDados] = useState<MetaStatus | null>(null);
  const [erro, setErro] = useState('');
  const [escolhendo, setEscolhendo] = useState(false);
  const [contaEscolhida, setContaEscolhida] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erroAcao, setErroAcao] = useState('');
  const [atualizandoContas, setAtualizandoContas] = useState(false);
  const [confirmandoDesconexao, setConfirmandoDesconexao] = useState(false);
  const [salvandoLoja, setSalvandoLoja] = useState(false);
  // Sem ref, o setInterval capturaria o `dados` do primeiro render e nunca pararia de pollar.
  const syncAtivo = useRef(false);

  function carregar() {
    return getMetaStatus()
      .then((d) => {
        setDados(d);
        setErro('');
        syncAtivo.current = d.syncEmAndamento;
        return d;
      })
      .catch((err: Error) => {
        setErro(err.message);
        return null;
      });
  }

  useEffect(() => {
    carregar();
  }, []);

  // Só pesquisa enquanto há sincronização rodando — tela parada não fica batendo no servidor.
  useEffect(() => {
    if (!dados?.syncEmAndamento) return undefined;
    const t = setInterval(() => {
      if (!syncAtivo.current) return;
      carregar();
    }, INTERVALO_POLL_MS);
    return () => clearInterval(t);
  }, [dados?.syncEmAndamento]);

  function abrirEscolha() {
    setEscolhendo(true);
    setErroAcao('');
    setContaEscolhida(dados?.contas.find((c) => c.selecionada)?.metaAccountId || '');
  }

  function atualizarContas() {
    setAtualizandoContas(true);
    setErroAcao('');
    listarMetaContas()
      .then((d) => setDados((atual) => (atual ? { ...atual, contas: d.contas } : atual)))
      .catch((err: Error) => setErroAcao(err.message))
      .finally(() => setAtualizandoContas(false));
  }

  function confirmarConta() {
    if (!contaEscolhida) return;
    setSalvando(true);
    setErroAcao('');
    selecionarMetaConta(contaEscolhida)
      .then(() => {
        setEscolhendo(false);
        return carregar().then(() => atualizarResumo());
      })
      .catch((err: Error) => setErroAcao(err.message))
      .finally(() => setSalvando(false));
  }

  function sincronizar() {
    setErroAcao('');
    sincronizarMetaAgora()
      .then(() => carregar())
      .then(() => atualizarResumo())
      .catch((err: Error) => setErroAcao(err.message));
  }

  async function confirmarDesconexao() {
    await desconectarMeta();
    setConfirmandoDesconexao(false);
    setEscolhendo(false);
    carregar().then(() => atualizarResumo());
  }

  const conexao = dados?.conexao;
  const conectado = conexao?.status === 'connected';
  const contaSelecionada = dados?.contas.find((c) => c.selecionada) || null;
  const precisaEscolherConta = conectado && !contaSelecionada;
  const ultimoSync = dados?.sincronizacoes[0] || null;

  // Erro vence ter conta escolhida: uma conexão quebrada com conta selecionada ainda está quebrada.
  // Na primeira versão a ordem era a inversa e o badge dizia "Conectado" logo acima da frase
  // "sua conexão expirou" — contradição na mesma linha.
  const comErro = conexao?.status === 'error';
  const tone = comErro ? 'danger' : contaSelecionada ? 'success' : precisaEscolherConta ? 'warning' : 'neutral';
  const label = comErro
    ? 'Atenção necessária'
    : contaSelecionada
      ? 'Conectado'
      : precisaEscolherConta
        ? 'Falta escolher a conta'
        : 'Não conectado';

  return (
    <Secao description="Conecte para acompanhar gasto, CPA, ROAS e criativos das campanhas do Facebook e Instagram dentro do painel.">
      {erro && <ErrorState description={erro} onRetry={carregar} />}
      {!erro && !dados && <Skeleton rows={3} />}
      {!erro && dados && conexao && (
        <div className="ds-stack">
          {!dados.oauthConfigurado && (
            <Callout tone="warning" title="Conexão com a Meta indisponível no momento">
              A conexão com a Meta ainda não está habilitada na plataforma. Assim que estiver, o botão Conectar fica disponível aqui.
            </Callout>
          )}

          <div className="ga-linha">
            <div className="ga-linha__topo">
              <span className="ga-linha__loja">{contaSelecionada?.nome || 'Meta Ads'}</span>
              <StatusBadge tone={tone} label={label} />
              {conexao.metaUserNome && <span className="ga-linha__meta">{conexao.metaUserNome}</span>}
              {contaSelecionada && <span className="ga-linha__meta">{mascararContaMeta(contaSelecionada.metaAccountId)}</span>}
              {conexao.ultimoSyncEm && <span className="ga-linha__meta">Sincronizado {idadeDoCache(conexao.ultimoSyncEm)}</span>}

              <span className="ga-linha__acao">
                {!conectado ? (
                  !ehOwner ? null : dados.oauthConfigurado ? (
                    <a className="ds-btn ds-btn--secondary ds-btn--sm" href={urlConectarMeta()}>
                      {conexao.status === 'disconnected' ? 'Conectar' : 'Reconectar'}
                    </a>
                  ) : (
                    <Button variant="secondary" size="sm" disabled title="Conexão com a Meta ainda não habilitada na plataforma">
                      {conexao.status === 'disconnected' ? 'Conectar' : 'Reconectar'}
                    </Button>
                  )
                ) : precisaEscolherConta ? (
                  ehOwner ? <Button variant="secondary" size="sm" onClick={abrirEscolha}>Escolher conta</Button> : null
                ) : (
                  <>
                    <Button variant="ghost" size="sm" disabled={dados.syncEmAndamento} onClick={sincronizar}>
                      {dados.syncEmAndamento ? 'Sincronizando…' : 'Sincronizar agora'}
                    </Button>
                    {ehOwner && <Button variant="ghost" size="sm" onClick={abrirEscolha}>Trocar conta</Button>}
                    {ehOwner && <Button variant="ghost" size="sm" onClick={() => setConfirmandoDesconexao(true)}>Desconectar</Button>}
                  </>
                )}
              </span>
            </div>

            {/* Token vencido é o único erro que o usuário resolve sozinho, e a ação fica junto da causa. */}
            {conexao.status === 'error' && (
              <p className="ga-linha__erro" role="alert">
                {mensagemErroMeta(conexao.ultimoErroCodigo, conexao.ultimoErro)}
              </p>
            )}

            {conectado && conexao.tokenExpiraEm && (
              <p className="pc-nota">
                Acesso válido até {formatData(conexao.tokenExpiraEm)}. A renovação é automática — só pedimos reconexão se ela falhar.
              </p>
            )}

            {/* A conta atribui o tráfego à loja da Organization ativa (a loja vem da sessão — Fase 3).
                Sem o vínculo o consolidado se recusa a calcular MER. */}
            {!ehOwner && <p className="pc-nota">Só o responsável pela loja conecta, troca ou desconecta esta integração.</p>}

            {contaSelecionada && ehOwner && (
              <div className="ga-linha__form">
                {contaSelecionada.atribuidaAEstaStore ? (
                  <span className="pc-nota">Tráfego desta conta leva para a sua loja.</span>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      disabled={salvandoLoja}
                      onClick={() => {
                        setSalvandoLoja(true);
                        setErroAcao('');
                        definirLojaDaContaMeta(contaSelecionada.metaAccountId)
                          .then(() => carregar())
                          .then(() => atualizarResumo())
                          .catch((err: Error) => setErroAcao(err.message))
                          .finally(() => setSalvandoLoja(false));
                      }}
                    >
                      Vincular esta conta à loja
                    </Button>
                    <span className="pc-nota">O Resultado consolidado precisa disto para calcular o MER.</span>
                  </>
                )}
              </div>
            )}

            {erroAcao && <p className="ga-linha__erro" role="alert">{erroAcao}</p>}

            {escolhendo && (
              <div className="ds-stack">
                {dados.contas.length === 0 ? (
                  <p className="pc-nota">Nenhuma conta de anúncios encontrada nesta conta Meta.</p>
                ) : (
                  <RadioCardGroup
                    name="meta-conta"
                    legend="Conta de anúncios a sincronizar"
                    value={contaEscolhida}
                    onChange={setContaEscolhida}
                    // Uma coluna: são até 7 contas, e o que distingue cada uma (id completo, fuso,
                    // status) não cabe em cartão estreito — em auto-fit o texto quebra em 3 linhas.
                    columns={1}
                    options={dados.contas.map((c) => ({
                      value: c.metaAccountId,
                      title: c.nome || c.metaAccountId,
                      description: descricaoConta(c),
                    }))}
                  />
                )}
                <div className="ga-linha__form">
                  <Button size="sm" disabled={!contaEscolhida || salvando} onClick={confirmarConta}>
                    {salvando ? 'Salvando…' : 'Usar esta conta'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={atualizandoContas} onClick={atualizarContas}>
                    {atualizandoContas ? 'Atualizando…' : 'Atualizar lista'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEscolhendo(false)}>Cancelar</Button>
                </div>
                <p className="pc-nota">
                  Ao escolher, o painel importa os últimos 90 dias em segundo plano. Dá pra sair desta tela — a importação continua.
                </p>
              </div>
            )}

            {/* Progresso da importação: sem isso, "Sincronizando…" não diz se está andando (spec §62). */}
            {dados.syncEmAndamento && ultimoSync && (
              <p className="pc-nota" aria-live="polite">
                {rotuloSync(ultimoSync)} em andamento — {plural(ultimoSync.registros, 'registro processado', 'registros processados')} até agora.
              </p>
            )}

            {/* Quando a sincronização falhou pela MESMA causa que derrubou a conexão, a frase acima
                já disse tudo — repetir só empilha o mesmo texto duas vezes. Só aparece quando o
                motivo é outro (ex.: rate limit, que não marca a conexão como quebrada). */}
            {!dados.syncEmAndamento && ultimoSync && ultimoSync.status === 'erro' && ultimoSync.erroCodigo !== conexao.ultimoErroCodigo && (
              <p className="ga-linha__erro" role="alert">
                {rotuloSync(ultimoSync)} falhou: {mensagemErroMeta(ultimoSync.erroCodigo, ultimoSync.erro)}
              </p>
            )}

            {!dados.syncEmAndamento && ultimoSync && ultimoSync.status === 'sucesso' && (
              <p className="pc-nota">
                {rotuloSync(ultimoSync)} concluída {idadeDoCache(ultimoSync.finalizadoEm)} —{' '}
                {plural(ultimoSync.registros, 'registro', 'registros')}
                {ultimoSync.de && ultimoSync.ate ? `, de ${formatDiaISO(ultimoSync.de)} a ${formatDiaISO(ultimoSync.ate)}` : ''}.
              </p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmandoDesconexao}
        onClose={() => setConfirmandoDesconexao(false)}
        title="Desconectar a Meta Ads?"
        description="O histórico de campanhas e métricas já sincronizado é apagado junto. Reconectar depois importa os últimos 90 dias de novo."
        confirmLabel="Desconectar"
        onConfirm={confirmarDesconexao}
      />
    </Secao>
  );
}
