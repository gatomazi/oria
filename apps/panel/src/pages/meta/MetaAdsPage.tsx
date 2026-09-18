import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Callout, PageHeader, PageStack, Skeleton, TabList } from '../../components/ds';
import { ApiError } from '../../api/client';
import { idadeDoCache } from '../../lib/format';
import { intervaloMeta, type PeriodoMeta } from '../../lib/meta';
import {
  getMetaConsolidado, getMetaCriativos, getMetaEntidades, getMetaOverview, getMetaStatus, getMetaTimeseries,
  type MetaConsolidado, type MetaCriativo, type MetaLinhaEntidade, type MetaMetas, type MetaNivel, type MetaOverview,
  type MetaPontoSerie, type MetaStatus,
} from '../../api/metaAds';
import { MetaAnuncioDrawer } from './MetaAnuncioDrawer';
import { MetaConsolidadoTab } from './MetaConsolidadoTab';
import { MetaCriativosTab } from './MetaCriativosTab';
import { MetaToolbar } from './MetaToolbar';
import { MetaTabelaTab } from './MetaTabelaTab';
import { MetaVisaoGeralTab } from './MetaVisaoGeralTab';

import '../../pedidos-central.css';
import '../../analytics.css';
import '../../meta-ads.css';

type Aba = 'visao-geral' | 'campaign' | 'adset' | 'ad' | 'criativos' | 'consolidado';

const ABAS: { value: Aba; label: string }[] = [
  { value: 'visao-geral', label: 'Visão geral' },
  { value: 'campaign', label: 'Campanhas' },
  { value: 'adset', label: 'Conjuntos' },
  { value: 'ad', label: 'Anúncios' },
  { value: 'criativos', label: 'Criativos' },
  { value: 'consolidado', label: 'Resultado' },
];

// Meta Ads — navegação pela hierarquia de mídia (spec §74). Todo número vem do Postgres, nunca da
// Meta ao vivo: o sync grava, a tela lê. Por isso trocar de período é instantâneo e não gasta cota.
// Tudo que uma consulta de período devolve. Guardado por chave de período pra trocar entre
// "7 dias" e "30 dias" não refazer requisição nenhuma — o dado não muda entre um clique e outro.
interface CachePeriodo {
  overview?: MetaOverview;
  serie?: MetaPontoSerie[];
  entidades: Partial<Record<MetaNivel, MetaLinhaEntidade[]>>;
  criativos?: MetaCriativo[];
  consolidado?: MetaConsolidado;
}

export function MetaAdsPage() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  // Aba e período vivem na URL: sobrevivem ao F5 (o usuário trocava pra 7 dias, recarregava e
  // voltava pra 30) e tornam a tela compartilhável — mandar o link já com o recorte certo.
  const [params, setParams] = useSearchParams();

  const aba = (params.get('aba') as Aba) || 'visao-geral';
  const periodo = (params.get('periodo') as PeriodoMeta) || '30d';
  const inicio = params.get('de') || '';
  const fim = params.get('ate') || '';

  function mudarParams(patch: Record<string, string | null>) {
    const novo = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') novo.delete(k); else novo.set(k, v);
    }
    // replace: trocar período não deve encher o histórico de voltas.
    setParams(novo, { replace: true });
  }

  const setAba = (v: Aba) => mudarParams({ aba: v === 'visao-geral' ? null : v });
  const setPeriodo = (v: PeriodoMeta) => mudarParams({ periodo: v === '30d' ? null : v });
  const setInicio = (v: string) => mudarParams({ de: v });
  const setFim = (v: string) => mudarParams({ ate: v });

  // Cache por chave de período. Em ref, não em state: guardá-lo em state faria cada gravação
  // disparar um render a mais sem nada pra mostrar.
  const cache = useRef<Record<string, CachePeriodo>>({});
  const [, forcarRender] = useState(0);

  const [metas, setMetas] = useState<MetaMetas | null>(null);
  const [direcaoBoa, setDirecaoBoa] = useState<Record<string, 'cima' | 'baixo' | 'neutro'> | null>(null);
  const [anuncioAberto, setAnuncioAberto] = useState<string | null>(null);
  const [erro, setErro] = useState('');
  const [atualizando, setAtualizando] = useState(false);

  // Filtro de contexto do drill-down: campanha → conjuntos dela → anúncios daquele conjunto.
  // Filtra no cliente porque a lista do período já vem inteira do servidor — ir buscar de novo só
  // pra aplicar um `where` seria uma ida de rede para um dado que já está na memória.
  const [filtroPai, setFiltroPai] = useState<{ id: string; nome: string; nivel: Aba } | null>(null);
  // Filtro vindo da aba Criativos: "quais anúncios usam esta peça?". É outro eixo que o drill-down
  // da hierarquia, por isso um estado próprio — os dois não fazem sentido ativos ao mesmo tempo.
  const [filtroCriativo, setFiltroCriativo] = useState<{ id: string; nome: string } | null>(null);

  const intervalo = intervaloMeta(periodo, inicio, fim);
  const chave = intervalo ? `${intervalo.from}:${intervalo.to}` : '';

  useEffect(() => {
    getMetaStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  function entrada(k: string): CachePeriodo {
    if (!cache.current[k]) cache.current[k] = { entidades: {} };
    return cache.current[k];
  }

  // `forcar` = o usuário clicou em Atualizar. Fora isso, período já visitado é servido do cache
  // sem ida de rede. Note o que NÃO acontece aqui: nada é zerado antes da resposta chegar. A
  // primeira versão fazia setOverview(null) e a página inteira virava esqueleto — com as consultas
  // levando de 35 a 680ms, o que se via era a tela piscando inteira, e isso lia como lentidão.
  // Agora o período anterior continua na tela até o novo chegar.
  function carregar(forcar = false) {
    if (!intervalo) return;
    const k = chave;
    const c = entrada(k);
    if (!forcar && c.overview && c.serie) return;
    setErro('');
    setAtualizando(true);
    const { from, to } = intervalo;
    Promise.all([
      getMetaOverview(from, to).then((d) => { entrada(k).overview = d; }),
      getMetaTimeseries(from, to).then((d) => { entrada(k).serie = d.serie; }),
    ])
      .then(() => forcarRender((n) => n + 1))
      .catch((err: Error) => setErro(err.message))
      .finally(() => setAtualizando(false));
  }

  useEffect(() => { carregar(); }, [chave]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cada nível é buscado na primeira vez que a aba é aberta naquele período — quem só quer a visão
  // geral não paga por três consultas de tabela, e voltar a uma aba já vista é instantâneo.
  useEffect(() => {
    if (aba === 'visao-geral' || aba === 'criativos' || aba === 'consolidado' || !intervalo) return;
    const k = chave;
    const nivel = aba as MetaNivel;
    if (entrada(k).entidades[nivel]) return;
    getMetaEntidades(nivel, intervalo.from, intervalo.to)
      .then((d) => { entrada(k).entidades[nivel] = d.linhas; forcarRender((n) => n + 1); })
      .catch((err: Error) => setErro(err.message));
  }, [aba, chave]); // eslint-disable-line react-hooks/exhaustive-deps

  // Criativos custam uma junção a mais (insights → anúncios → criativos) e são a consulta mais cara
  // das quatro, então também só carregam quando a aba é aberta. As metas vêm na mesma resposta.
  function carregarCriativos(forcar = false) {
    if (!intervalo) return;
    const k = chave;
    if (!forcar && entrada(k).criativos) return;
    getMetaCriativos(intervalo.from, intervalo.to)
      .then((d) => { entrada(k).criativos = d.linhas; setMetas(d.metas); setDirecaoBoa(d.direcaoBoa); forcarRender((n) => n + 1); })
      .catch((err: Error) => setErro(err.message));
  }
  useEffect(() => {
    if (aba !== 'criativos') return;
    carregarCriativos();
  }, [aba, chave]); // eslint-disable-line react-hooks/exhaustive-deps

  // O consolidado é a única aba que pode falhar por CONFIGURAÇÃO (loja da conta não definida), e
  // não por erro — por isso guarda o código do erro separado, pra a tela oferecer a ação certa.
  const [erroConsolidado, setErroConsolidado] = useState<{ msg: string; codigo: string | null }>({ msg: '', codigo: null });
  function carregarConsolidado(forcar = false) {
    if (!intervalo) return;
    const k = chave;
    if (!forcar && entrada(k).consolidado) return;
    setErroConsolidado({ msg: '', codigo: null });
    getMetaConsolidado(intervalo.from, intervalo.to)
      .then((d) => { entrada(k).consolidado = d; forcarRender((n) => n + 1); })
      .catch((err: Error) => {
        setErroConsolidado({ msg: err.message, codigo: err instanceof ApiError ? err.codigo : null });
      });
  }
  useEffect(() => {
    if (aba !== 'consolidado') return;
    carregarConsolidado();
  }, [aba, chave]); // eslint-disable-line react-hooks/exhaustive-deps

  // Salvar metas muda a sinalização de TODOS os períodos já em cache, não só o visível.
  function invalidarCriativos() {
    for (const k of Object.keys(cache.current)) delete cache.current[k].criativos;
    carregarCriativos(true);
  }

  const conectado = status?.conexao.status === 'connected';
  const contaSelecionada = status?.contas.some((c) => c.selecionada);

  if (status && (!conectado || !contaSelecionada)) {
    return (
      <PageStack>
        <PageHeader title="Meta Ads" description="Campanhas, conjuntos e anúncios do Facebook e Instagram." />
        <Callout
          tone="info"
          title={conectado ? 'Falta escolher a conta de anúncios' : 'Meta Ads ainda não conectada'}
          action={<Link className="ds-btn ds-btn--secondary ds-btn--sm" to="/admin/integracoes">Ir para Integrações</Link>}
        >
          {conectado
            ? 'A conta Meta está conectada, mas nenhuma conta de anúncios foi escolhida ainda. Escolha em Integrações para o painel importar o histórico.'
            : 'Conecte a conta Meta em Integrações. Enquanto isso, nenhum número aparece aqui — esta tela só mostra dado real sincronizado da Meta.'}
        </Callout>
      </PageStack>
    );
  }

  if (!status) {
    return (
      <PageStack>
        <PageHeader title="Meta Ads" />
        <Skeleton rows={1} height="88px" />
      </PageStack>
    );
  }

  const atual = cache.current[chave];
  const overview = atual?.overview ?? null;
  const serie = atual?.serie ?? null;
  const criativos = atual?.criativos ?? null;
  const consolidado = atual?.consolidado ?? null;
  const linhasDaAba = aba === 'visao-geral' || aba === 'criativos' || aba === 'consolidado' ? null : atual?.entidades[aba as MetaNivel] ?? null;
  let linhasFiltradas = linhasDaAba;
  if (linhasFiltradas && filtroCriativo && aba === 'ad') {
    linhasFiltradas = linhasFiltradas.filter((l) => l.criativoId === filtroCriativo.id);
  } else if (linhasFiltradas && filtroPai && filtroPai.nivel === aba) {
    linhasFiltradas = linhasFiltradas.filter((l) => l.paiId === filtroPai.id);
  }

  function drilldown(linha: MetaLinhaEntidade) {
    const proximo: Aba | null = aba === 'campaign' ? 'adset' : aba === 'adset' ? 'ad' : null;
    if (!proximo) return;
    setFiltroCriativo(null);
    setFiltroPai({ id: linha.id, nome: linha.nome || linha.id, nivel: proximo });
    setAba(proximo);
  }

  return (
    <PageStack>
      <PageHeader
        title="Meta Ads"
        description={
          overview?.conta.nome
            ? `${overview.conta.nome} — campanhas, conjuntos e anúncios do Facebook e Instagram.`
            : 'Campanhas, conjuntos e anúncios do Facebook e Instagram.'
        }
      />

      <MetaToolbar
        label="Filtrar desempenho do Meta Ads"
        periodo={periodo}
        onPeriodo={setPeriodo}
        inicio={inicio}
        onInicio={setInicio}
        fim={fim}
        onFim={setFim}
        atualizando={atualizando}
        onAtualizar={() => { delete cache.current[chave]; carregar(true); }}
        podeAtualizar={!!intervalo}
      />

      {periodo === 'custom' && !intervalo && (
        <p className="pc-nota">Escolha as duas datas pra carregar o período personalizado.</p>
      )}

      {status.conexao.ultimoSyncEm && (
        <p className="pc-nota">
          Última sincronização com a Meta {idadeDoCache(status.conexao.ultimoSyncEm)}
          {status.syncEmAndamento ? ' · sincronizando agora' : ''}.
        </p>
      )}

      <TabList label="Níveis do Meta Ads" value={aba} onChange={setAba} items={ABAS} />

      {/* O filtro de drill-down precisa ser visível e reversível: sem isso, a aba Conjuntos mostraria
          um subconjunto sem explicar por quê, e pareceria dado faltando. */}
      {filtroPai && filtroPai.nivel === aba && (
        <Callout tone="info" title={`Mostrando só o que pertence a "${filtroPai.nome}"`}
          action={<Button variant="ghost" size="sm" onClick={() => setFiltroPai(null)}>Ver todos</Button>}
        >
          Você chegou aqui clicando numa linha do nível anterior.
        </Callout>
      )}

      {filtroCriativo && aba === 'ad' && (
        <Callout tone="info" title={`Mostrando só os anúncios que usam "${filtroCriativo.nome}"`}
          action={<Button variant="ghost" size="sm" onClick={() => setFiltroCriativo(null)}>Ver todos</Button>}
        >
          Você chegou aqui pela aba Criativos.
        </Callout>
      )}

      {aba === 'visao-geral' ? (
        <MetaVisaoGeralTab dados={overview} serie={serie} erro={erro} onRecarregar={() => carregar(true)} />
      ) : aba === 'consolidado' ? (
        <MetaConsolidadoTab
          dados={consolidado}
          erro={erroConsolidado.msg}
          codigoErro={erroConsolidado.codigo}
          onRecarregar={() => carregarConsolidado(true)}
        />
      ) : aba === 'criativos' ? (
        <MetaCriativosTab
          linhas={criativos}
          metas={metas}
          direcaoBoa={direcaoBoa}
          erro={erro}
          onRecarregar={invalidarCriativos}
          onAbrirAnuncio={(c) => { setFiltroPai(null); setFiltroCriativo({ id: c.id, nome: c.nome }); setAba('ad'); }}
        />
      ) : (
        <MetaTabelaTab
          nivel={aba as MetaNivel}
          linhas={linhasFiltradas}
          erro={erro}
          onRecarregar={() => carregar(true)}
          onDrilldown={aba === 'ad' ? (l) => setAnuncioAberto(l.id) : drilldown}
        />
      )}

      <MetaAnuncioDrawer
        adId={anuncioAberto}
        from={intervalo?.from || ''}
        to={intervalo?.to || ''}
        onClose={() => setAnuncioAberto(null)}
      />
    </PageStack>
  );
}
