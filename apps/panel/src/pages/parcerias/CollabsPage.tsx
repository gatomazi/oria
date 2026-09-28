import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Button, Callout, Card, DataTable, EmptyState, ErrorState, Field, Input, KpiCard, KpiStrip, Modal, PageHeader, PageStack, Select, Skeleton, StatusBadge, Textarea,
} from '../../components/ds';
import { afiliados, type CollabDaLista, type Contrato, type ParceiroDaLista, type ProdutoDaCollab, type ProdutoDoCatalogo } from '../../api/afiliados';
import { useAsync } from '../../lib/useAsync';
import { toast } from '../../lib/toast';
import { bpsDeTexto, brl, dataCurta, mensagemDoErro, pct, plural } from '../../lib/parcerias';
import { MotivoDialog } from './modais';
import { useParcerias } from './ParceriasLayout';

const ROTULO_STATUS = { draft: 'Rascunho', active: 'Ativa', ended: 'Encerrada' } as const;
const TOM_STATUS = { draft: 'neutral', active: 'success', ended: 'neutral' } as const;

function NovaCollabDialog({ open, onClose, onCriada }: { open: boolean; onClose: () => void; onCriada: (id: string) => void }) {
  const [nome, setNome] = useState('');
  const [url, setUrl] = useState('');
  const [imagem, setImagem] = useState('');
  const [politica, setPolitica] = useState('require_approval');
  const [notas, setNotas] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  useEffect(() => { if (open) { setNome(''); setUrl(''); setImagem(''); setPolitica('require_approval'); setNotas(''); setErro(''); } }, [open]);
  async function salvar() {
    setEnviando(true); setErro('');
    try {
      const c = await afiliados.criarCollab({ name: nome.trim(), collectionUrl: url.trim() || undefined, imageUrl: imagem.trim() || undefined, newMemberPolicy: politica, notes: notas.trim() || undefined });
      toast('Collab criada em rascunho.', 'sucesso'); onCriada(c.id);
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title="Nova collab" confirmLabel={enviando ? 'Aguarde…' : 'Criar'} confirmDisabled={enviando || !nome.trim()} onConfirm={salvar} maxWidth={560}>
      <div className="pa-form">
        <Field label="Nome interno" required hint="Ex.: “Praia do Rosa · Amanda”."><Input value={nome} maxLength={160} onChange={(e) => setNome(e.target.value)} /></Field>
        <Field label="Página ou coleção" optional hint="Precisa começar com https://."><Input value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} /></Field>
        <Field label="Imagem de prévia" optional><Input value={imagem} maxLength={500} onChange={(e) => setImagem(e.target.value)} placeholder="https://…" /></Field>
        <Field label="Novos produtos do mesmo agrupamento" hint="Padrão seguro: só entram depois da sua aprovação, e nunca retroativamente.">
          <Select value={politica} onChange={(e) => setPolitica(e.target.value)}><option value="require_approval">Exigir aprovação (padrão)</option><option value="auto_include">Incluir automaticamente</option></Select>
        </Field>
        <Field label="Observações" optional><Textarea rows={2} value={notas} maxLength={4000} onChange={(e) => setNotas(e.target.value)} /></Field>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

export function CollabsPage() {
  const { isOwner } = useParcerias();
  const navigate = useNavigate();
  const [novo, setNovo] = useState(false);
  const { dado, erro, carregando, recarregar } = useAsync(() => afiliados.collabs(), []);
  return (
    <PageStack>
      <PageHeader title="Collabs" description="Uma arte, vários produtos: o criador comissiona por item vendido da estampa — com ou sem cupom." actions={<Button onClick={() => setNovo(true)}>Nova collab</Button>} />
      {erro && <ErrorState description={erro} onRetry={recarregar} />}
      {carregando && !dado && <Skeleton variant="table" rows={5} />}
      {dado && !dado.itens.length && <EmptyState title="Nenhuma collab" description="Crie a collab, vincule o criador (contrato de collab) e os produtos da estampa. Produto isolado, sem agrupamento, funciona igual." action={<Button onClick={() => setNovo(true)}>Nova collab</Button>} />}
      {dado && dado.itens.length > 0 && (
        <DataTable<CollabDaLista>
          label="Collabs" rows={dado.itens} rowKey={(c) => c.id} onRowClick={(c) => navigate(`/admin/parcerias/collabs/${c.id}`)}
          columns={[
            { key: 'n', label: 'Collab', sortValue: (c) => c.name, render: (c) => <strong>{c.name}</strong> },
            { key: 's', label: 'Situação', render: (c) => <StatusBadge tone={TOM_STATUS[c.status]} label={ROTULO_STATUS[c.status]} /> },
            { key: 'c', label: 'Criadores', priority: 'low', render: (c) => (c.creators.length ? c.creators.map((x) => `${x.name} (${pct(x.shareBps)})`).join(', ') : <span className="pa-muted">sem criador</span>) },
            { key: 'p', label: 'Produtos', align: 'right', render: (c) => `${c.activeProducts}${c.pendingProducts ? ` · ${plural(c.pendingProducts, 'pendente')}` : ''}` },
            { key: 'u', label: 'Unidades vendidas', align: 'right', priority: 'low', sortValue: (c) => c.units, render: (c) => String(c.units) },
          ]}
        />
      )}
      {!isOwner && <p className="pa-aviso">Adicionar criadores e produtos, aprovar propostas e encerrar collabs são ações do owner.</p>}
      <NovaCollabDialog open={novo} onClose={() => setNovo(false)} onCriada={(id) => { setNovo(false); navigate(`/admin/parcerias/collabs/${id}`); }} />
    </PageStack>
  );
}

// ── Detalhe ─────────────────────────────────────────────────────────────────────────────────────
function AdicionarCriadorDialog({ open, onClose, collabId, onSalvo }: { open: boolean; onClose: () => void; collabId: string; onSalvo: () => void }) {
  const [parceiros, setParceiros] = useState<ParceiroDaLista[]>([]);
  const [partnerId, setPartnerId] = useState('');
  const [contratos, setContratos] = useState<Contrato[]>([]);
  const [contractId, setContractId] = useState('');
  const [share, setShare] = useState('100');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!open) return;
    setPartnerId(''); setContratos([]); setContractId(''); setShare('100'); setErro('');
    afiliados.parceiros({ limit: 100, sort: 'name', applicationStatus: 'approved' }).then((r) => setParceiros(r.itens)).catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!partnerId) { setContratos([]); setContractId(''); return; }
    afiliados.perfil(partnerId).then((p) => {
      const ok = p.contracts.filter((k) => k.modality !== 'coupon');
      setContratos(ok); setContractId(ok[0]?.id ?? '');
    }).catch((e) => setErro(mensagemDoErro(e)));
  }, [partnerId]);

  const bps = bpsDeTexto(share);
  async function salvar() {
    setEnviando(true); setErro('');
    try { await afiliados.adicionarCriador(collabId, { partnerId, contractId, shareBps: bps ?? 0 }); toast('Criador vinculado à collab.', 'sucesso'); onSalvo(); onClose(); }
    catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title="Adicionar criador" confirmLabel={enviando ? 'Aguarde…' : 'Adicionar'} confirmDisabled={enviando || !partnerId || !contractId || !bps || bps <= 0 || bps > 10000} onConfirm={salvar} maxWidth={520}>
      <div className="pa-form">
        <p className="pa-aviso">A participação é a fatia da base do item sobre a qual o contrato do criador incide. Vários criadores: as fatias somam no máximo 100% e cada um tem o seu ledger. Sem regra válida, a venda vai para revisão manual — nunca paga duas vezes.</p>
        <Field label="Parceiro" required>
          <Select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}><option value="">Escolha…</option>{parceiros.map((p) => <option key={p.id} value={p.id}>{p.publicName}</option>)}</Select>
        </Field>
        <Field label="Contrato de collab" required hint="Precisa ser um contrato de collab ou híbrido do parceiro.">
          <Select value={contractId} onChange={(e) => setContractId(e.target.value)} disabled={!contratos.length}>{contratos.map((k) => <option key={k.id} value={k.id}>{k.title}{k.current.status !== 'active' ? ` (${k.current.status === 'draft' ? 'rascunho' : k.current.status})` : ''}</option>)}</Select>
        </Field>
        {partnerId && !contratos.length && <Callout tone="warning">Este parceiro não tem contrato de collab. Crie um no perfil dele.</Callout>}
        <Field label="Participação (%)" required><Input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} /></Field>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

function AdicionarProdutosDialog({ open, onClose, collabId, onSalvo }: { open: boolean; onClose: () => void; collabId: string; onSalvo: () => void }) {
  const [q, setQ] = useState('');
  const [itens, setItens] = useState<ProdutoDoCatalogo[]>([]);
  const [sel, setSel] = useState<Record<string, ProdutoDoCatalogo>>({});
  const [manual, setManual] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => { if (open) { setQ(''); setSel({}); setManual(''); setErro(''); } }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => { afiliados.produtosDoCatalogo(q).then((r) => setItens(r.itens)).catch((e) => setErro(mensagemDoErro(e))); }, 250);
    return () => clearTimeout(t);
  }, [open, q]);

  const escolhidos = Object.values(sel);
  const idsManuais = manual.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const manualInvalido = idsManuais.some((x) => !/^\d{1,18}$/.test(x));
  const total = escolhidos.length + idsManuais.length;

  async function salvar() {
    setEnviando(true); setErro('');
    try {
      const produtos = [...escolhidos.map((p) => ({ inkProductId: p.inkProductId, productName: p.name })), ...idsManuais.filter((id) => !sel[id]).map((id) => ({ inkProductId: id }))];
      const r = await afiliados.adicionarProdutos(collabId, { products: produtos });
      toast(`${plural(r.adicionados.length, 'produto adicionado', 'produtos adicionados')}. Só vendas a partir de agora comissionam.`, 'sucesso'); onSalvo(); onClose();
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }

  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title="Adicionar produtos à collab" confirmLabel={enviando ? 'Aguarde…' : `Adicionar ${total || ''}`.trim()} confirmDisabled={enviando || total === 0 || manualInvalido} onConfirm={salvar} maxWidth={680}>
      <div className="pa-form">
        <p className="pa-aviso">Vale para camiseta, peruana, oversized, caneca, ecobag… da mesma loja. A apuração usa o <strong>id do produto</strong> da linha do pedido — nunca nome, imagem ou semelhança. A associação começa agora (não retroativa).</p>
        <Field label="Buscar no catálogo sincronizado"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou id do produto" /></Field>
        <div className="pa-produtos">
          {itens.map((p) => {
            const marcado = !!sel[p.inkProductId];
            const ocupado = !!p.collabId && p.collabId !== collabId;
            return (
              <button key={p.inkProductId} type="button" className="pa-produto" disabled={ocupado} aria-pressed={marcado} onClick={() => setSel((s) => { const n = { ...s }; if (n[p.inkProductId]) delete n[p.inkProductId]; else n[p.inkProductId] = p; return n; })}>
                {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : null}
                <span><span className="pa-produto__nome">{marcado ? '✓ ' : ''}{p.name}</span><span className="pa-produto__meta">id {p.inkProductId}{p.clusterId ? ` · agrupamento ${p.clusterId}` : ' · sem agrupamento'}{ocupado ? ' · já em outra collab' : p.collabId ? ' · já nesta collab' : ''}</span></span>
              </button>
            );
          })}
        </div>
        {!itens.length && <p className="pa-aviso">Nenhum produto no catálogo sincronizado com esse termo. Se o produto ainda não sincronizou, informe o id abaixo.</p>}
        <Field label="Ou informe ids de produto da INK" optional hint="Separe por vírgula ou espaço. Serve para produto isolado, sem agrupamento.">
          <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="12345, 67890" aria-invalid={manualInvalido} />
        </Field>
        {manualInvalido && <Callout tone="warning">Use só números inteiros (ids da INK).</Callout>}
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

export function CollabDetalhePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { isOwner, tz } = useParcerias();
  const { dado, erro, carregando, recarregar } = useAsync(() => afiliados.collab(id), [id]);
  const [criador, setCriador] = useState(false);
  const [produtos, setProdutos] = useState(false);
  const [acao, setAcao] = useState<{ tipo: 'remover' | 'rejeitar' | 'encerrar-criador'; alvo: string; nome: string } | null>(null);
  const [descoberta, setDescoberta] = useState<{ encontrados: ProdutoDaCollab[]; clusters: string[] } | null>(null);
  const [buscando, setBuscando] = useState(false);

  if (erro) return <PageStack><ErrorState title="Collab não encontrada" description={erro} onRetry={recarregar} action={<Button variant="secondary" onClick={() => navigate('/admin/parcerias/collabs')}>Voltar</Button>} /></PageStack>;
  if (carregando && !dado) return <PageStack><Skeleton rows={1} height="48px" width="40%" /><Skeleton variant="table" rows={5} /></PageStack>;
  if (!dado) return null;
  const c = dado.collab;
  const pendentes = dado.products.filter((p) => p.status === 'pending_approval');

  async function descobrir() {
    setBuscando(true);
    try {
      const r = await afiliados.descobrirProdutos(id);
      setDescoberta(r);
      toast(r.encontrados.length ? `${plural(r.encontrados.length, 'produto novo encontrado', 'produtos novos encontrados')} no agrupamento.` : 'Nenhum produto novo no agrupamento.', 'sucesso');
      recarregar();
    } catch (e) { toast(mensagemDoErro(e)); } finally { setBuscando(false); }
  }
  async function mudarStatus(status: 'active' | 'ended') {
    try { await afiliados.atualizarCollab(id, { status }); toast('Collab atualizada.', 'sucesso'); recarregar(); } catch (e) { toast(mensagemDoErro(e)); }
  }

  return (
    <PageStack>
      <PageHeader
        title={c.name} back={{ to: '/admin/parcerias/collabs', label: 'Collabs' }} description={c.collectionUrl ? undefined : 'Sem página de coleção informada.'}
        meta={<span className="pa-badges"><StatusBadge tone={TOM_STATUS[c.status]} label={ROTULO_STATUS[c.status]} /><span className="pa-muted">desde {dataCurta(c.startsAt, tz)}{c.endsAt ? ` até ${dataCurta(c.endsAt, tz)}` : ''}</span>{c.collectionUrl && <a className="pa-link" href={c.collectionUrl} target="_blank" rel="noopener noreferrer">Abrir coleção</a>}</span>}
        actions={isOwner ? [
          ...(c.status === 'draft' ? [<Button key="a" onClick={() => mudarStatus('active')}>Ativar collab</Button>] : []),
          ...(c.status !== 'ended' ? [<Button key="e" variant="danger" onClick={() => mudarStatus('ended')}>Encerrar</Button>] : []),
        ] : undefined}
      />
      <KpiStrip label="Resultado da collab">
        <KpiCard title="Unidades vendidas" value={String(dado.summary.units)} helper="itens da arte, sem devolução" />
        <KpiCard title="Pedidos" value={String(dado.summary.orders)} helper="unidades e pedidos são diferentes" />
        <KpiCard title="Receita líquida atribuída" value={brl(dado.summary.netRevenueCents)} helper="não é receita incremental" />
        <KpiCard title="Comissão gerada" value={isOwner ? brl(dado.summary.commissionCents) : '—'} helper="todos os criadores" />
      </KpiStrip>

      <Card title="Criadores" description="Participação contratual explícita por criador." action={isOwner ? <Button size="sm" variant="secondary" onClick={() => setCriador(true)}>Adicionar criador</Button> : undefined}>
        {!dado.creators.length ? <EmptyState title="Sem criador" description="Sem criador com contrato ativo, as vendas desta collab vão para revisão manual." /> : (
          <DataTable
            label="Criadores da collab" rows={dado.creators} rowKey={(x) => x.id} compact
            columns={[
              { key: 'p', label: 'Parceiro', render: (x) => <Link className="pa-link" to={`/admin/parcerias/parceiros/${x.partnerId}`}>{x.partnerName}</Link> },
              { key: 's', label: 'Participação', align: 'right', render: (x) => pct(x.shareBps) },
              { key: 'v', label: 'Vigência', render: (x) => `${dataCurta(x.validFrom, tz)} → ${x.validTo ? dataCurta(x.validTo, tz) : 'atual'}` },
              { key: 'a', label: 'Ações', align: 'right', render: (x) => (isOwner && !x.validTo ? <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'encerrar-criador', alvo: x.id, nome: x.partnerName })}>Remover</Button> : null) },
            ]}
          />
        )}
      </Card>

      <Card
        title="Produtos da estampa" description="O vínculo é versionado: o pedido usa o produto exato que compunha a collab na data da venda."
        action={isOwner ? <span className="pa-badges"><Button size="sm" variant="secondary" onClick={descobrir} disabled={buscando}>{buscando ? 'Buscando…' : 'Buscar no agrupamento'}</Button><Button size="sm" onClick={() => setProdutos(true)}>Adicionar produtos</Button></span> : undefined}
      >
        {pendentes.length > 0 && <Callout tone="warning" title={`${plural(pendentes.length, 'produto novo aguarda', 'produtos novos aguardam')} aprovação`}>Produtos do mesmo agrupamento só comissionam depois de aprovados — e nunca de forma retroativa.</Callout>}
        {descoberta && descoberta.encontrados.length > 0 && <p className="pa-aviso">Impacto estimado (últimos 90 dias, se já estivessem na collab): {descoberta.encontrados.map((e) => `${e.productName ?? e.inkProductId}: ${plural(e.impactoUltimos90d?.unidades ?? 0, 'unidade')}`).join(' · ')}. Vendas anteriores não são alteradas.</p>}
        {!dado.products.length ? <EmptyState title="Nenhum produto" description="Adicione o produto da estampa (mesmo isolado, sem agrupamento)." /> : (
          <div className="pa-produtos">
            {dado.products.map((p) => (
              <div key={p.id} className={`pa-produto${p.status === 'pending_approval' ? ' pa-produto--pendente' : p.status === 'removed' ? ' pa-produto--removido' : ''}`}>
                {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : null}
                <div>
                  <div className="pa-produto__nome">{p.catalogName ?? p.productName ?? `Produto ${p.inkProductId}`}</div>
                  <div className="pa-produto__meta">id {p.inkProductId} · {p.status === 'active' ? `ativo desde ${dataCurta(p.validFrom, tz)}` : p.status === 'pending_approval' ? 'aguardando aprovação' : `removido em ${dataCurta(p.validTo, tz)}`}</div>
                  <div className="pa-produto__meta">{dado.unitsByProduct.find((u) => u.inkProductId === p.inkProductId)?.units ?? 0} un. vendidas</div>
                  {isOwner && p.status === 'pending_approval' && (
                    <span className="pa-badges">
                      <Button size="sm" onClick={async () => { try { await afiliados.aprovarProduto(id, p.id); toast('Produto aprovado. Vale a partir de agora.', 'sucesso'); recarregar(); } catch (e) { toast(mensagemDoErro(e)); } }}>Aprovar</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'rejeitar', alvo: p.id, nome: p.productName ?? p.inkProductId })}>Rejeitar</Button>
                    </span>
                  )}
                  {isOwner && p.status === 'active' && <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'remover', alvo: p.id, nome: p.productName ?? p.inkProductId })}>Remover</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <AdicionarCriadorDialog open={criador} onClose={() => setCriador(false)} collabId={id} onSalvo={recarregar} />
      <AdicionarProdutosDialog open={produtos} onClose={() => setProdutos(false)} collabId={id} onSalvo={recarregar} />
      <MotivoDialog
        open={!!acao} onClose={() => setAcao(null)} confirmVariant="danger-solid"
        titulo={acao?.tipo === 'remover' ? `Remover “${acao?.nome}” da collab` : acao?.tipo === 'rejeitar' ? `Rejeitar “${acao?.nome}”` : `Remover ${acao?.nome ?? 'criador'} da collab`}
        descricao={acao?.tipo === 'remover' ? 'A vigência fecha agora. Vendas anteriores continuam atribuídas ao produto que compunha a collab na data.' : acao?.tipo === 'rejeitar' ? 'A proposta é descartada e nada é comissionado.' : 'O criador deixa de participar de vendas novas; o histórico fica.'}
        onConfirm={async (m) => {
          if (!acao) return;
          if (acao.tipo === 'remover') await afiliados.removerProduto(id, acao.alvo, m);
          else if (acao.tipo === 'rejeitar') await afiliados.rejeitarProduto(id, acao.alvo, m);
          else await afiliados.encerrarCriador(id, acao.alvo, m);
          toast('Collab atualizada.', 'sucesso'); recarregar();
        }}
      />
    </PageStack>
  );
}
