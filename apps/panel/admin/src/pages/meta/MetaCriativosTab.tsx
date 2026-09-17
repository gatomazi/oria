import { useMemo, useState } from 'react';
import {
  Button, Callout, Disclosure, EmptyState, ErrorState, Field, Input, Select, Skeleton, StatusBadge, Toolbar, Tooltip,
} from '../../components/ds';
import {
  META_FORMATO_ROTULO, META_SINAL_ROTULO, metaNumero, metaPercentual, metaReais, metaRoas, metaSegundos,
  metaVariacao, tendenciaMeta, type DirecaoBoa,
} from '../../lib/meta';
import { salvarMetaMetas, type MetaCriativo, type MetaMetas } from '../../api/metaAds';

interface Props {
  linhas: MetaCriativo[] | null;
  metas: MetaMetas | null;
  direcaoBoa: Record<string, DirecaoBoa> | null;
  erro: string;
  onRecarregar: () => void;
  onAbrirAnuncio?: (criativo: MetaCriativo) => void;
}

type Ordem = 'spend' | 'roas' | 'cpa' | 'ctr' | 'purchases' | 'impressions' | 'frequency';

const ORDENS: { valor: Ordem; rotulo: string }[] = [
  { valor: 'spend', rotulo: 'Maior gasto' },
  { valor: 'roas', rotulo: 'Melhor ROAS' },
  { valor: 'cpa', rotulo: 'Menor CPA' },
  { valor: 'ctr', rotulo: 'Maior CTR' },
  { valor: 'purchases', rotulo: 'Mais compras' },
  { valor: 'impressions', rotulo: 'Mais impressões' },
  { valor: 'frequency', rotulo: 'Maior frequência' },
];

// Formulário das metas (spec §50). Campo vazio = "não avaliar por isto", e é assim que nasce: sem
// nenhum valor da Use Origens embutido no código.
function MetasForm({ metas, onSalvo }: { metas: MetaMetas; onSalvo: (m: MetaMetas) => void }) {
  const [form, setForm] = useState<Record<keyof MetaMetas, string>>({
    cpaAlvo: metas.cpaAlvo?.toString() ?? '',
    roasAlvo: metas.roasAlvo?.toString() ?? '',
    ctrMinimo: metas.ctrMinimo?.toString() ?? '',
    gastoMinimo: metas.gastoMinimo?.toString() ?? '',
  });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  function campo(k: keyof MetaMetas, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function salvar() {
    setSalvando(true);
    setErro('');
    const payload = Object.fromEntries(
      Object.entries(form).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)])
    ) as unknown as MetaMetas;
    salvarMetaMetas(payload)
      .then((d) => onSalvo(d.metas))
      .catch((err: Error) => setErro(err.message))
      .finally(() => setSalvando(false));
  }

  return (
    <div className="ds-stack">
      <p className="pc-nota">
        Sem meta preenchida, o painel mostra as métricas e não opina sobre eficiência. Campo vazio
        significa “não avaliar por isto”.
      </p>
      <div className="ds-form-grid">
        <Field label="ROAS alvo" hint="ex.: 3 para 3x">
          <Input type="number" min="0" step="0.1" value={form.roasAlvo} onChange={(e) => campo('roasAlvo', e.target.value)} placeholder="—" />
        </Field>
        <Field label="CPA alvo (R$)">
          <Input type="number" min="0" step="0.01" value={form.cpaAlvo} onChange={(e) => campo('cpaAlvo', e.target.value)} placeholder="—" />
        </Field>
        <Field label="CTR mínimo (%)">
          <Input type="number" min="0" step="0.1" value={form.ctrMinimo} onChange={(e) => campo('ctrMinimo', e.target.value)} placeholder="—" />
        </Field>
        <Field label="Gasto mínimo (R$)" hint="abaixo disso, nenhum julgamento">
          <Input type="number" min="0" step="1" value={form.gastoMinimo} onChange={(e) => campo('gastoMinimo', e.target.value)} placeholder="—" />
        </Field>
      </div>
      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
      <div>
        <Button size="sm" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando…' : 'Salvar metas'}</Button>
      </div>
    </div>
  );
}

// Barra de retenção de vídeo: de quem deu play, quantos chegaram a cada marco. Só aparece pra
// criativo com play — anúncio de imagem não tem retenção 0%, não tem retenção (spec §20).
function Retencao({ c }: { c: MetaCriativo }) {
  if (!c.retencao) return null;
  const marcos: [string, number | null][] = [
    ['25%', c.retencao.p25], ['50%', c.retencao.p50], ['75%', c.retencao.p75], ['100%', c.retencao.p100],
  ];
  return (
    <div className="meta-criativo__retencao">
      {marcos.map(([rotulo, v]) => (
        <span key={rotulo} className="meta-criativo__marco" title={`${rotulo} do vídeo assistido`}>
          <span className="meta-criativo__marco-trilho">
            <span className="meta-criativo__marco-preenchimento" style={{ transform: `scaleX(${Math.max(0.01, Math.min(1, (v ?? 0) / 100))})` }} />
          </span>
          <span className="meta-criativo__marco-rotulo">{rotulo}</span>
          <span className="meta-criativo__marco-valor">{v === null ? '—' : metaPercentual(v, 0)}</span>
        </span>
      ))}
    </div>
  );
}

// Variação de uma métrica do criativo, com a MESMA semântica da Visão Geral: cor vem da direção boa
// da métrica (subir CPA é ruim), e variação que arredonda pra zero não ganha cor nenhuma.
function Delta({ v, chave, direcao }: { v: number | null | undefined; chave: string; direcao: Record<string, DirecaoBoa> | null }) {
  const texto = metaVariacao(v);
  if (!texto) return null;
  const trend = tendenciaMeta(v, direcao ? direcao[chave] : undefined);
  const classe = trend ? `meta-criativo__delta meta-criativo__delta--${trend}` : 'meta-criativo__delta';
  return <span className={classe}>{texto}</span>;
}

export function MetaCriativosTab({ linhas, metas, direcaoBoa, erro, onRecarregar, onAbrirAnuncio }: Props) {
  const [formato, setFormato] = useState('todos');
  const [ordem, setOrdem] = useState<Ordem>('spend');
  const [metasAtuais, setMetasAtuais] = useState<MetaMetas | null>(metas);

  const visiveis = useMemo(() => {
    if (!linhas) return [];
    const filtradas = formato === 'todos' ? linhas : linhas.filter((l) => l.formato === formato);
    // Métrica incalculável (null) vai pro fim em qualquer ordenação: um criativo sem compra alguma
    // tem o "menor CPA" do jeito errado, e encabeçar o ranking com ele seria mentira (spec §63).
    return [...filtradas].sort((a, b) => {
      const va = a[ordem];
      const vb = b[ordem];
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return ordem === 'cpa' ? va - vb : vb - va;
    });
  }, [linhas, formato, ordem]);

  if (erro) return <ErrorState description={erro} onRetry={onRecarregar} />;
  if (!linhas) return <Skeleton rows={4} height="120px" />;

  const metasVigentes = metasAtuais ?? metas;
  const temMeta = !!metasVigentes && [metasVigentes.roasAlvo, metasVigentes.cpaAlvo, metasVigentes.ctrMinimo].some((x) => x !== null);
  const formatosPresentes = Array.from(new Set(linhas.map((l) => l.formato)));

  return (
    <div className="ds-stack">
      <Disclosure summary={temMeta ? 'Metas de eficiência' : 'Definir metas de eficiência'}>
        {metasVigentes && <MetasForm metas={metasVigentes} onSalvo={(m) => { setMetasAtuais(m); onRecarregar(); }} />}
      </Disclosure>

      {!temMeta && (
        <Callout tone="info" title="Nenhuma meta definida">
          Os criativos aparecem com as métricas reais, mas sem sinalização de eficiência. Defina ROAS
          alvo, CPA alvo ou CTR mínimo acima para o painel destacar quem está acima e abaixo da meta.
        </Callout>
      )}

      <Toolbar label="Filtrar criativos">
        <Select aria-label="Formato" value={formato} onChange={(e) => setFormato(e.target.value)}>
          <option value="todos">Todos os formatos</option>
          {formatosPresentes.map((f) => (
            <option key={f} value={f}>{META_FORMATO_ROTULO[f] || f}</option>
          ))}
        </Select>
        <Select aria-label="Ordenar por" value={ordem} onChange={(e) => setOrdem(e.target.value as Ordem)}>
          {ORDENS.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
        </Select>
      </Toolbar>

      {visiveis.length === 0 ? (
        <EmptyState
          title={linhas.length === 0 ? 'Nenhum criativo com entrega no período' : 'Nenhum criativo neste formato'}
          description={
            linhas.length === 0
              ? 'Só aparece aqui a peça que teve impressão ou investimento no intervalo escolhido.'
              : 'Troque o filtro de formato para ver os demais.'
          }
        />
      ) : (
        <div className="meta-criativos">
          {visiveis.map((c) => {
            const sinal = c.sinal ? META_SINAL_ROTULO[c.sinal] : null;
            return (
              <article key={c.id} className="meta-criativo">
                <div className="meta-criativo__midia">
                  {c.thumbnailUrl
                    ? <img className="meta-criativo__img" src={c.thumbnailUrl} alt="" loading="lazy" />
                    : <span className="meta-criativo__img meta-criativo__img--vazia" aria-hidden="true" />}
                </div>

                <div className="meta-criativo__corpo">
                  <header className="meta-criativo__topo">
                    <h3 className="meta-criativo__nome" title={c.nome}>{c.nome}</h3>
                    <StatusBadge tone="neutral" label={META_FORMATO_ROTULO[c.formato] || c.formato} />
                    {sinal && (
                      // O motivo vai no tooltip porque o badge sozinho seria um veredito do sistema;
                      // com o porquê à vista, dá pra discordar dele (spec §49).
                      <Tooltip content={c.motivos.join(' · ')}>
                        <span><StatusBadge tone={sinal.tom} label={sinal.label} /></span>
                      </Tooltip>
                    )}
                  </header>

                  <dl className="meta-criativo__metricas">
                    <div><dt>Gasto</dt><dd>{metaReais(c.spend)} <Delta v={c.variacoes?.spend} chave="spend" direcao={direcaoBoa} /></dd></div>
                    <div><dt>Compras</dt><dd>{metaNumero(c.purchases)} <Delta v={c.variacoes?.purchases} chave="purchases" direcao={direcaoBoa} /></dd></div>
                    <div><dt>Receita</dt><dd>{metaReais(c.purchaseValue)} <Delta v={c.variacoes?.purchaseValue} chave="purchaseValue" direcao={direcaoBoa} /></dd></div>
                    <div><dt>ROAS</dt><dd>{metaRoas(c.roas)} <Delta v={c.variacoes?.roas} chave="roas" direcao={direcaoBoa} /></dd></div>
                    <div><dt>CPA</dt><dd>{metaReais(c.cpa)} <Delta v={c.variacoes?.cpa} chave="cpa" direcao={direcaoBoa} /></dd></div>
                    <div><dt>CTR</dt><dd>{metaPercentual(c.ctr)} <Delta v={c.variacoes?.ctr} chave="ctr" direcao={direcaoBoa} /></dd></div>
                    {c.retencao && (
                      <div><dt>Tempo médio</dt><dd>{metaSegundos(c.videoAvgWatchTime)}</dd></div>
                    )}
                  </dl>

                  <Retencao c={c} />

                  <footer className="meta-criativo__rodape">
                    <span className="pc-nota" title={c.nomesAnuncios || undefined}>
                      {c.anuncios === 1 ? 'em 1 anúncio' : `em ${c.anuncios} anúncios`}
                    </span>
                    {onAbrirAnuncio && (
                      <Button variant="ghost" size="sm" onClick={() => onAbrirAnuncio(c)}>Ver anúncios</Button>
                    )}
                  </footer>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
