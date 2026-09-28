import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Callout, Checkbox, DataTable, Drawer, EmptyState, ErrorState, Field, Input, PageHeader, PageStack, Pagination, SearchInput, Select, Skeleton, StatusBadge, Textarea, Toolbar } from '../../components/ds';
import { afiliados, type ParceiroDaLista, type Perfil } from '../../api/afiliados';
import { useAsync } from '../../lib/useAsync';
import { useFiltrosUrl } from '../../lib/useFiltrosUrl';
import { toast } from '../../lib/toast';
import {
  NIVEIS_ORDEM, ROTULOS_CANDIDATURA, ROTULOS_MODALIDADE, ROTULOS_VINCULO, TOM_VINCULO, brl, dataCurta, mensagemDoErro, plural,
} from '../../lib/parcerias';
import { Saude } from './componentes';
import { useParcerias } from './ParceriasLayout';

const PADRAO = { q: '', applicationStatus: '', relationshipStatus: '', modality: '', level: '', noSaleDays: '', sort: 'name', dir: 'asc', page: '1' };
const POR_PAGINA = 25;
const REDES = ['instagram', 'tiktok', 'youtube', 'x', 'facebook', 'kwai', 'twitch', 'site', 'outro'];

function NovoParceiroDrawer({ open, onClose, isOwner, onCriado }: { open: boolean; onClose: () => void; isOwner: boolean; onCriado: (id: string) => void }) {
  const [nome, setNome] = useState('');
  const [contato, setContato] = useState('');
  const [email, setEmail] = useState('');
  const [telefone, setTelefone] = useState('');
  const [rede, setRede] = useState('instagram');
  const [handle, setHandle] = useState('');
  const [origem, setOrigem] = useState('');
  const [regiao, setRegiao] = useState('');
  const [notas, setNotas] = useState('');
  const [legado, setLegado] = useState(false);
  const [aprovar, setAprovar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!open) return;
    setNome(''); setContato(''); setEmail(''); setTelefone(''); setRede('instagram'); setHandle(''); setOrigem(''); setRegiao(''); setNotas(''); setLegado(false); setAprovar(false); setErro('');
  }, [open]);

  async function salvar() {
    setEnviando(true); setErro('');
    try {
      const perfis: Perfil[] = handle.trim() ? [{ network: rede, handle: handle.trim(), url: null }] : [];
      const p = await afiliados.criarParceiro({
        publicName: nome.trim(), contactName: contato.trim() || null, contactEmail: email.trim() || null, contactPhone: telefone.trim() || null, profiles: perfis,
        origin: origem.trim() || null, communityRegion: regiao.trim() || null, internalNotes: notas.trim() || null, legacyInkAffiliate: legado, approve: aprovar,
      });
      toast(aprovar ? 'Parceiro cadastrado e aprovado.' : 'Candidato cadastrado.', 'sucesso');
      onCriado(p.id);
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }

  return (
    <Drawer
      open={open} onClose={() => { if (!enviando) onClose(); }} title="Novo parceiro" description="Só o necessário: dados bancários e documentos ficam fora desta versão."
      footer={<><Button variant="secondary" onClick={onClose} disabled={enviando}>Cancelar</Button><Button onClick={salvar} disabled={enviando || !nome.trim()}>{enviando ? 'Aguarde…' : 'Cadastrar'}</Button></>}
    >
      <div className="pa-form">
        <Field label="Nome público" required><Input value={nome} maxLength={120} onChange={(e) => setNome(e.target.value)} autoFocus /></Field>
        <Field label="Contato comercial" optional><Input value={contato} maxLength={160} onChange={(e) => setContato(e.target.value)} /></Field>
        <div className="pa-form__linha">
          <Field label="E-mail comercial" optional><Input type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Telefone/WhatsApp" optional><Input value={telefone} maxLength={40} onChange={(e) => setTelefone(e.target.value)} /></Field>
        </div>
        <div className="pa-form__linha">
          <Field label="Rede principal"><Select value={rede} onChange={(e) => setRede(e.target.value)}>{REDES.map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field>
          <Field label="Perfil (@)" optional><Input value={handle} maxLength={80} onChange={(e) => setHandle(e.target.value)} placeholder="@usuario" /></Field>
        </div>
        <div className="pa-form__linha">
          <Field label="Origem da candidatura" optional><Input value={origem} maxLength={120} onChange={(e) => setOrigem(e.target.value)} placeholder="indicação, formulário…" /></Field>
          <Field label="Comunidade / região" optional><Input value={regiao} maxLength={120} onChange={(e) => setRegiao(e.target.value)} /></Field>
        </div>
        <Field label="Observações internas" optional><Textarea rows={3} value={notas} maxLength={4000} onChange={(e) => setNotas(e.target.value)} /></Field>
        <Checkbox label="Legado: este parceiro já tinha afiliado nativo na INK" description="O Oria tem o próprio programa de afiliados e não usa o da INK — não crie afiliado lá. Marque só se ele já existia (conta antiga): a API da INK não informa isso e, marcado, as vendas dele ficam bloqueadas para não pagar em dobro até você conciliar." checked={legado} onChange={(e) => setLegado(e.target.checked)} />
        {isOwner && <Checkbox label="Aprovar já (sem passar por candidato)" description="Aprovar não dá comissão nem peça grátis: falta contrato ativo." checked={aprovar} onChange={(e) => setAprovar(e.target.checked)} />}
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Drawer>
  );
}

export function ParceirosPage() {
  const { isOwner, tz } = useParcerias();
  const navigate = useNavigate();
  const { valores, alterar, limpar, ativos } = useFiltrosUrl(PADRAO);
  const [novo, setNovo] = useState(false);
  const [busca, setBusca] = useState(valores.q);
  const pagina = Math.max(1, Number.parseInt(valores.page, 10) || 1);

  useEffect(() => { setBusca(valores.q); }, [valores.q]);
  useEffect(() => {
    const t = setTimeout(() => { if (busca !== valores.q) alterar({ q: busca }); }, 300);
    return () => clearTimeout(t);
  }, [busca, valores.q, alterar]);

  const { dado, erro, carregando, recarregar } = useAsync(
    () => afiliados.parceiros({ ...valores, limit: POR_PAGINA, offset: (pagina - 1) * POR_PAGINA }),
    [valores.q, valores.applicationStatus, valores.relationshipStatus, valores.modality, valores.level, valores.noSaleDays, valores.sort, valores.dir, pagina],
  );
  const totalPaginas = dado ? Math.max(1, Math.ceil(dado.total / POR_PAGINA)) : 1;

  return (
    <PageStack>
      <PageHeader title="Parceiros" description="Candidatos e parceiros da sua loja — cupom, collab ou os dois." actions={<Button onClick={() => setNovo(true)}>Novo parceiro</Button>} />

      <Toolbar label="Filtros de parceiros" end={dado ? <span className="ds-toolbar__meta">{plural(dado.total, 'parceiro')}</span> : undefined}>
        <SearchInput aria-label="Buscar parceiro por nome, @, e-mail ou cupom" placeholder="Nome, @, e-mail ou cupom" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <Select aria-label="Candidatura" controlSize="sm" value={valores.applicationStatus} onChange={(e) => alterar({ applicationStatus: e.target.value })}>
          <option value="">Toda candidatura</option>{(Object.keys(ROTULOS_CANDIDATURA) as (keyof typeof ROTULOS_CANDIDATURA)[]).map((k) => <option key={k} value={k}>{ROTULOS_CANDIDATURA[k]}</option>)}
        </Select>
        <Select aria-label="Vínculo" controlSize="sm" value={valores.relationshipStatus} onChange={(e) => alterar({ relationshipStatus: e.target.value })}>
          <option value="">Todo vínculo</option>{(Object.keys(ROTULOS_VINCULO) as (keyof typeof ROTULOS_VINCULO)[]).map((k) => <option key={k} value={k}>{ROTULOS_VINCULO[k]}</option>)}
        </Select>
        <Select aria-label="Modalidade" controlSize="sm" value={valores.modality} onChange={(e) => alterar({ modality: e.target.value })}>
          <option value="">Toda modalidade</option>{(Object.keys(ROTULOS_MODALIDADE) as (keyof typeof ROTULOS_MODALIDADE)[]).map((k) => <option key={k} value={k}>{ROTULOS_MODALIDADE[k]}</option>)}
        </Select>
        <Select aria-label="Nível" controlSize="sm" value={valores.level} onChange={(e) => alterar({ level: e.target.value })}>
          <option value="">Todo nível</option>{NIVEIS_ORDEM.map((n) => <option key={n} value={n}>{n.charAt(0).toUpperCase() + n.slice(1)}</option>)}
        </Select>
        <Select aria-label="Sem venda há" controlSize="sm" value={valores.noSaleDays} onChange={(e) => alterar({ noSaleDays: e.target.value })}>
          <option value="">Qualquer atividade</option><option value="30">Sem venda há 30 dias</option><option value="60">Sem venda há 60 dias</option><option value="90">Sem venda há 90 dias</option>
        </Select>
        {ativos > 0 && <Button variant="ghost" size="sm" onClick={() => { setBusca(''); limpar(); }}>Limpar filtros ({ativos})</Button>}
      </Toolbar>

      {erro && <ErrorState description={erro} onRetry={recarregar} />}
      {carregando && !dado && <Skeleton variant="table" rows={8} />}
      {dado && !dado.itens.length && (
        <EmptyState
          title={ativos ? 'Nenhum parceiro com esses filtros' : 'Nenhum parceiro cadastrado'}
          description={ativos ? undefined : 'Cadastre a primeira pessoa, defina o contrato e ative um cupom ou uma collab. Nada comissiona antes do contrato ativo.'}
          action={ativos ? <Button variant="secondary" onClick={() => { setBusca(''); limpar(); }}>Limpar filtros</Button> : <Button onClick={() => setNovo(true)}>Novo parceiro</Button>}
        />
      )}
      {dado && dado.itens.length > 0 && (
        <>
          <DataTable<ParceiroDaLista>
            label="Parceiros" rows={dado.itens} rowKey={(p) => p.id} onRowClick={(p) => navigate(`/admin/parcerias/parceiros/${p.id}`)}
            sortable sort={{ key: valores.sort, direction: valores.dir === 'desc' ? 'desc' : 'asc' }} onSortChange={(s) => alterar({ sort: s.key, dir: s.direction })}
            columns={[
              { key: 'name', label: 'Parceiro', sortValue: (p) => p.publicName, render: (p) => (<><strong>{p.publicName}</strong>{p.contactEmail ? <div className="pa-muted">{p.contactEmail}</div> : null}</>) },
              {
                key: 'situacao', label: 'Situação',
                render: (p) => (
                  <span className="pa-badges">
                    {p.applicationStatus !== 'approved' && <StatusBadge tone={p.applicationStatus === 'rejected' ? 'danger' : 'warning'} label={ROTULOS_CANDIDATURA[p.applicationStatus]} />}
                    <StatusBadge tone={TOM_VINCULO[p.relationshipStatus]} label={ROTULOS_VINCULO[p.relationshipStatus]} />
                  </span>
                ),
              },
              { key: 'mod', label: 'Modalidade', priority: 'low', render: (p) => (p.modalities.length ? p.modalities.map((m) => ROTULOS_MODALIDADE[m]).join(' + ') : '—') },
              { key: 'lvl', label: 'Nível', priority: 'low', render: (p) => (p.level ? p.level.charAt(0).toUpperCase() + p.level.slice(1) : '—') },
              { key: 'cup', label: 'Cupons', priority: 'low', render: (p) => (p.coupons.length ? p.coupons.join(', ') : '—') },
              { key: 'lastSale', label: 'Última venda', priority: 'low', align: 'right', sortValue: (p) => p.lastSaleAt, render: (p) => dataCurta(p.lastSaleAt, tz) },
              ...(isOwner ? [{ key: 'saldo', label: 'Saldo liberado', align: 'right' as const, render: (p: ParceiroDaLista) => (p.balance ? brl(p.balance.releasedCents) : '—') }] : []),
              { key: 'saude', label: 'Saúde', render: (p) => <Saude flags={p.health} /> },
            ]}
          />
          <Pagination page={pagina} totalPages={totalPaginas} totalLabel={plural(dado.total, 'parceiro')} onPrev={() => alterar({ page: String(pagina - 1) })} onNext={() => alterar({ page: String(pagina + 1) })} />
        </>
      )}

      <NovoParceiroDrawer open={novo} onClose={() => setNovo(false)} isOwner={isOwner} onCriado={(id) => { setNovo(false); navigate(`/admin/parcerias/parceiros/${id}`); }} />
    </PageStack>
  );
}
