import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, DataTable, EmptyState, ErrorState, Field, Modal, PageHeader, PageStack, Pagination, Select, Skeleton, Textarea, Toolbar, Input } from '../../components/ds';
import { afiliados, type Cupom, type ItemEmRevisao, type ParceiroDaLista } from '../../api/afiliados';
import { useAsync } from '../../lib/useAsync';
import { useFiltrosUrl } from '../../lib/useFiltrosUrl';
import { toast } from '../../lib/toast';
import { ROTULOS_MOTIVO_REVISAO, dataCurta, intervaloDoPreset, mensagemDoErro, plural, ROTULOS_DE_PERIODO, type PresetDePeriodo } from '../../lib/parcerias';
import { useParcerias } from './ParceriasLayout';
import { TabelaDeVendas } from './ParceiroPerfilPage';

const PADRAO = { range: '30d', from: '', to: '', basis: '', status: '', partnerId: '', page: '1' };
const POR_PAGINA = 25;

// ── Vendas atribuídas (todas) ───────────────────────────────────────────────────────────────────
export function VendasPage() {
  const { tz } = useParcerias();
  const { valores, alterar, limpar, ativos } = useFiltrosUrl(PADRAO);
  const pagina = Math.max(1, Number.parseInt(valores.page, 10) || 1);
  const [parceiros, setParceiros] = useState<ParceiroDaLista[]>([]);
  useEffect(() => { afiliados.parceiros({ limit: 100, sort: 'name' }).then((r) => setParceiros(r.itens)).catch(() => undefined); }, []);

  const periodo = useMemo(() => {
    if (valores.from && valores.to) return { from: valores.from, to: valores.to };
    const preset = (valores.range || '30d') as PresetDePeriodo;
    return intervaloDoPreset(preset === 'custom' ? '30d' : preset, tz);
  }, [valores.from, valores.to, valores.range, tz]);

  const { dado, erro, carregando, recarregar } = useAsync(
    () => afiliados.vendas({ from: periodo.from, to: periodo.to, basis: valores.basis || undefined, status: valores.status || undefined, partnerId: valores.partnerId || undefined, limit: POR_PAGINA, offset: (pagina - 1) * POR_PAGINA }),
    [periodo.from, periodo.to, valores.basis, valores.status, valores.partnerId, pagina],
  );

  function escolherPreset(v: PresetDePeriodo) {
    if (v === 'custom') alterar({ range: 'custom', from: periodo.from, to: periodo.to });
    else { const i = intervaloDoPreset(v, tz); alterar({ range: v, from: i.from, to: i.to }); }
  }

  return (
    <PageStack>
      <PageHeader title="Vendas atribuídas" description="Cada linha é um item de pedido: quem recebe, por qual regra e quanto. A atribuição por cupom não prova causalidade — não é receita incremental." />
      <Toolbar label="Filtros de vendas" end={dado ? <span className="ds-toolbar__meta">{plural(dado.total, 'linha')}</span> : undefined}>
        <Select aria-label="Período" controlSize="sm" value={valores.range || '30d'} onChange={(e) => escolherPreset(e.target.value as PresetDePeriodo)}>
          {(Object.keys(ROTULOS_DE_PERIODO) as PresetDePeriodo[]).map((p) => <option key={p} value={p}>{ROTULOS_DE_PERIODO[p]}</option>)}
        </Select>
        {valores.range === 'custom' && (
          <>
            <Input type="date" controlSize="sm" aria-label="De" value={periodo.from} onChange={(e) => alterar({ from: e.target.value })} />
            <Input type="date" controlSize="sm" aria-label="Até" value={periodo.to} onChange={(e) => alterar({ to: e.target.value })} />
          </>
        )}
        <Select aria-label="Parceiro" controlSize="sm" value={valores.partnerId} onChange={(e) => alterar({ partnerId: e.target.value })}>
          <option value="">Todos os parceiros</option>{parceiros.map((p) => <option key={p.id} value={p.id}>{p.publicName}</option>)}
        </Select>
        <Select aria-label="Origem" controlSize="sm" value={valores.basis} onChange={(e) => alterar({ basis: e.target.value })}>
          <option value="">Cupom e collab</option><option value="coupon">Cupom</option><option value="collab">Collab</option>
        </Select>
        <Select aria-label="Situação" controlSize="sm" value={valores.status} onChange={(e) => alterar({ status: e.target.value })}>
          <option value="">Toda situação</option><option value="calculated">Calculadas</option><option value="manual_review">Em revisão</option><option value="blocked">Bloqueadas</option>
        </Select>
        {ativos > 0 && <Button variant="ghost" size="sm" onClick={limpar}>Limpar filtros ({ativos})</Button>}
      </Toolbar>
      <p className="pa-periodo">Data do pedido de {dataCurta(`${periodo.from}T12:00:00Z`, 'UTC')} a {dataCurta(`${periodo.to}T12:00:00Z`, 'UTC')} · fuso {tz}</p>
      {erro && <ErrorState description={erro} onRetry={recarregar} />}
      {carregando && !dado && <Skeleton variant="table" rows={6} />}
      {dado && !dado.itens.length && <EmptyState title="Nenhuma venda atribuída" description="Pedidos com um cupom de parceiro ativo, ou com produtos de uma collab, aparecem aqui depois da reconciliação. Pedidos antigos, anteriores à captura do cupom, ficam em Revisões." />}
      {dado && dado.itens.length > 0 && (
        <>
          <TabelaDeVendas vendas={dado.itens} tz={tz} mostrarParceiro />
          <Pagination page={pagina} totalPages={Math.max(1, Math.ceil(dado.total / POR_PAGINA))} totalLabel={plural(dado.total, 'linha')} onPrev={() => alterar({ page: String(pagina - 1) })} onNext={() => alterar({ page: String(pagina + 1) })} />
        </>
      )}
    </PageStack>
  );
}

// ── Revisões ────────────────────────────────────────────────────────────────────────────────────
function ResolverDialog({ item, onClose, onResolvido }: { item: ItemEmRevisao | null; onClose: () => void; onResolvido: () => void }) {
  const [decisao, setDecisao] = useState<'assign_collab' | 'assign_coupon' | 'dismiss'>('dismiss');
  const [collabId, setCollabId] = useState('');
  const [cupomId, setCupomId] = useState('');
  const [motivo, setMotivo] = useState('');
  const [collabs, setCollabs] = useState<{ id: string; name: string }[]>([]);
  const [cupons, setCupons] = useState<Cupom[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!item) return;
    setDecisao('dismiss'); setCollabId(''); setCupomId(''); setMotivo(''); setErro('');
    afiliados.collabs().then((r) => { setCollabs(r.itens.map((c) => ({ id: c.id, name: c.name }))); setCollabId(r.itens[0]?.id ?? ''); }).catch(() => undefined);
    afiliados.cupons().then((r) => { setCupons(r.itens.filter((c) => c.status !== 'ended')); setCupomId(r.itens.find((c) => c.status !== 'ended')?.id ?? ''); }).catch(() => undefined);
  }, [item]);

  const podeAssociar = item?.inkItemId !== null;
  async function salvar() {
    if (!item) return;
    setEnviando(true); setErro('');
    try {
      await afiliados.resolverRevisao(item.id, { decision: decisao, reason: motivo.trim(), collabId: decisao === 'assign_collab' ? collabId : undefined, couponLinkId: decisao === 'assign_coupon' ? cupomId : undefined });
      toast('Item tratado e auditado.', 'sucesso'); onResolvido(); onClose();
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  return (
    <Modal open={!!item} onClose={() => { if (!enviando) onClose(); }} title={`Tratar item do pedido #${item?.inkOrderId ?? ''}`} confirmLabel={enviando ? 'Aguarde…' : 'Confirmar'} confirmDisabled={enviando || !motivo.trim() || (decisao === 'assign_collab' && !collabId) || (decisao === 'assign_coupon' && !cupomId)} onConfirm={salvar} maxWidth={560}>
      <div className="pa-form">
        <p className="pa-aviso">{item ? ROTULOS_MOTIVO_REVISAO[item.reason] ?? item.reason : ''}</p>
        <Field label="O que fazer">
          <Select value={decisao} onChange={(e) => setDecisao(e.target.value as typeof decisao)}>
            <option value="dismiss">Descartar (sem comissão)</option>
            {podeAssociar && <option value="assign_collab">Associar à collab…</option>}
            {podeAssociar && <option value="assign_coupon">Associar ao cupom…</option>}
          </Select>
        </Field>
        {decisao === 'assign_collab' && <Field label="Collab" required><Select value={collabId} onChange={(e) => setCollabId(e.target.value)}>{collabs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
        {decisao === 'assign_coupon' && <Field label="Cupom" required><Select value={cupomId} onChange={(e) => setCupomId(e.target.value)}>{cupons.map((c) => <option key={c.id} value={c.id}>{c.codeDisplay}</option>)}</Select></Field>}
        <Field label="Motivo" required hint="A associação manual fica na auditoria e vale só para este item."><Textarea rows={3} value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></Field>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

export function RevisoesPage() {
  const { isOwner } = useParcerias();
  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed'>('open');
  const { dado, erro, carregando, recarregar } = useAsync(() => afiliados.revisoes(status), [status]);
  const [tratar, setTratar] = useState<ItemEmRevisao | null>(null);
  return (
    <PageStack>
      <PageHeader title="Revisões" description="O que o Oria não decide sozinho: produto ausente, dado incompleto, custo desconhecido ou colisão. Nada aqui vira dinheiro liberado." />
      <Toolbar label="Filtro de revisões"><Select aria-label="Situação" controlSize="sm" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="open">Abertas</option><option value="resolved">Resolvidas</option><option value="dismissed">Descartadas</option></Select></Toolbar>
      {erro && <ErrorState description={erro} onRetry={recarregar} />}
      {carregando && !dado && <Skeleton variant="table" rows={5} />}
      {dado && !dado.itens.length && <EmptyState title={status === 'open' ? 'Nada pendente' : 'Nada por aqui'} description={status === 'open' ? 'Quando um item de pedido não puder ser atribuído com segurança, ele aparece aqui.' : undefined} />}
      {dado && dado.itens.length > 0 && (
        <DataTable<ItemEmRevisao>
          label="Itens em revisão" rows={dado.itens} rowKey={(r) => r.id}
          columns={[
            { key: 'p', label: 'Pedido', render: (r) => <Link className="pa-link" to={`/admin/pedidos-central?order=${encodeURIComponent(r.inkOrderId)}`}>#{r.inkOrderId}</Link> },
            { key: 'i', label: 'Item', priority: 'low', render: (r) => (r.inkItemId ? `${r.productName ?? `item ${r.inkItemId}`}${r.sku ? ` · ${r.sku}` : ''}` : 'pedido inteiro') },
            { key: 'm', label: 'Motivo', render: (r) => ROTULOS_MOTIVO_REVISAO[r.reason] ?? r.reason },
            { key: 'n', label: 'Nota', priority: 'low', render: (r) => r.resolutionNote ?? '—' },
            { key: 'a', label: 'Ações', align: 'right', render: (r) => (isOwner && r.status === 'open' ? <Button size="sm" onClick={() => setTratar(r)}>Tratar</Button> : null) },
          ]}
        />
      )}
      <ResolverDialog item={tratar} onClose={() => setTratar(null)} onResolvido={recarregar} />
    </PageStack>
  );
}
