import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FormActions,
  FormGrid,
  FormStack,
  Input,
  MediaDropzone,
  PageStack,
  RadioCardGroup,
  Skeleton,
  StatusBadge,
  Textarea,
  type Column,
} from '../../components/ds';
import { toast } from '../../lib/toast';
import { formatData, plural } from '../../lib/format';
import {
  archiveProduct,
  archiveProfile,
  arquivoParaBase64,
  createProduct,
  getCriativosStatus,
  listProducts,
  listProfiles,
  type Catalog,
  type Product,
  type ProfileKind,
  type ProfileRow,
} from '../../api/criativos';
import { ContextoEditor } from './ContextoEditor';
import { EnrichmentReviewModal } from './EnrichmentReview';
import { KitEditor } from './KitEditor';
import { PersonaEditor } from './PersonaEditor';
import type { KitKind } from './kitTemplate';

// ── Produtos ──────────────────────────────────────────────────────────────

interface Imagem { filename: string; sizeBytes: number; previewUrl: string; data_base64: string }

// Mesmos formatos que o servidor aceita (validados por magic bytes em lib/creative-core/storage.js).
const MIMES_IMAGEM_PRODUTO = ['image/png', 'image/jpeg', 'image/webp'];

export function ProdutosTab() {
  const [produtos, setProdutos] = useState<Product[] | null>(null);
  const [erroCarga, setErroCarga] = useState('');
  const [form, setForm] = useState({ name: '', type: '', description: '', city: '', state: '' });
  const [imagens, setImagens] = useState<Imagem[]>([]);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [arquivar, setArquivar] = useState<Product | null>(null);
  // Fase F.1 — Product Enrichment: liberado por Organization (CREATIVE_ENRICHMENT_ORGS), sempre com
  // provider "fake" nesta fase. A tela pergunta o status uma vez, aqui mesmo — sem prop nova em toda a
  // árvore só por causa de um botão condicional.
  const [enrichmentHabilitado, setEnrichmentHabilitado] = useState(false);
  const [enriquecendo, setEnriquecendo] = useState<Product | null>(null);

  const carregar = useCallback(() => {
    setErroCarga('');
    listProducts().then((r) => setProdutos(r.items)).catch((e: Error) => setErroCarga(e.message));
  }, []);
  useEffect(carregar, [carregar]);
  useEffect(() => { getCriativosStatus().then((s) => setEnrichmentHabilitado(s.enrichment)).catch(() => {}); }, []);

  async function adicionarImagem(file: File) {
    // Arrastar e soltar ignora o accept do seletor: confere o tipo aqui também.
    if (!MIMES_IMAGEM_PRODUTO.includes(file.type)) throw new Error('Formato não suportado. Use PNG, JPEG ou WebP.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Imagem maior que 10 MB.');
    const data = await arquivoParaBase64(file);
    setImagens((atual) => [...atual, { filename: file.name, sizeBytes: file.size, previewUrl: URL.createObjectURL(file), data_base64: data }]);
  }

  function salvar(ev: FormEvent) {
    ev.preventDefault();
    setSalvando(true);
    setErro('');
    const metadata = form.city || form.state ? { city: form.city || undefined, state: form.state || undefined } : undefined;
    createProduct({ name: form.name, type: form.type, description: form.description || undefined, metadata, images: imagens.map((i) => ({ data_base64: i.data_base64 })) })
      .then(() => {
        toast('Produto cadastrado.', 'sucesso');
        setForm({ name: '', type: '', description: '', city: '', state: '' });
        setImagens([]);
        carregar();
      })
      .catch((e: Error) => setErro(e.message))
      .finally(() => setSalvando(false));
  }

  const columns: Column<Product>[] = [
    { key: 'name', label: 'Produto', render: (p) => p.name, sortValue: (p) => p.name, truncate: true },
    { key: 'type', label: 'Tipo', render: (p) => p.type, priority: 'low' },
    { key: 'refs', label: 'Referências', align: 'right', render: (p) => plural(p.references.length, 'imagem', 'imagens') },
    { key: 'createdAt', label: 'Cadastro', render: (p) => formatData(p.createdAt), priority: 'low' },
    {
      key: 'acoes', label: 'Ações', hideLabel: true, render: (p) => (
        <>
          {enrichmentHabilitado && <Button size="sm" variant="ghost" onClick={() => setEnriquecendo(p)}>Enriquecer</Button>}
          <Button size="sm" variant="ghost" onClick={() => setArquivar(p)}>Arquivar</Button>
        </>
      ),
    },
  ];

  return (
    <PageStack>
      <Card title="Novo produto" description="Qualquer tipo de produto. As imagens (PNG, JPEG ou WebP, até 10 MB) são a referência de arte que o gerador preserva.">
        <FormStack onSubmit={salvar}>
          <FormGrid>
            <Field label="Nome" required><Input maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Tipo" required hint="ex.: camiseta, caneca, vela aromática"><Input maxLength={120} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} /></Field>
            <Field label="Cidade" optional hint="Usada pelo contexto geográfico"><Input maxLength={120} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
            <Field label="UF" optional><Input maxLength={2} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase() })} /></Field>
          </FormGrid>
          <Field label="Descrição" optional><Textarea rows={2} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {imagens.map((img, i) => (
            <MediaDropzone key={img.previewUrl} accept="image" acceptMime={MIMES_IMAGEM_PRODUTO.join(',')} value={img} onUpload={async () => {}} onRemove={() => setImagens(imagens.filter((_, j) => j !== i))} />
          ))}
          {imagens.length < 4 && <MediaDropzone accept="image" acceptMime={MIMES_IMAGEM_PRODUTO.join(',')} value={null} onUpload={adicionarImagem} onRemove={() => {}} />}
          {erro && <p className="ds-form-error" role="alert">{erro}</p>}
          <FormActions>
            <Button type="submit" disabled={salvando || !form.name || !form.type || imagens.length === 0}>{salvando ? 'Salvando…' : 'Cadastrar produto'}</Button>
          </FormActions>
        </FormStack>
      </Card>
      {erroCarga && <ErrorState description={erroCarga} onRetry={carregar} />}
      {!erroCarga && !produtos && <Skeleton variant="table" rows={3} />}
      {produtos && produtos.length === 0 && <EmptyState title="Nenhum produto" description="Cadastre ao menos um produto com imagem para gerar criativos." />}
      {produtos && produtos.length > 0 && <DataTable label="Produtos do gerador" columns={columns} rows={produtos} rowKey={(p) => p.id} />}
      <ConfirmDialog
        open={Boolean(arquivar)}
        title="Arquivar produto?"
        description="Ele deixa de aparecer no gerador. Criativos já gerados continuam no histórico."
        confirmLabel="Arquivar"
        confirmVariant="danger-solid"
        onClose={() => setArquivar(null)}
        onConfirm={() => { if (arquivar) archiveProduct(arquivar.id).then(carregar).catch(() => {}); setArquivar(null); }}
      />
      {enriquecendo && (
        <EnrichmentReviewModal product={enriquecendo} onClose={() => setEnriquecendo(null)} onDecided={carregar} />
      )}
    </PageStack>
  );
}

// ── Brand Kit / Niche Kit / Context Profile (formulários guiados validados pelo contrato do core) ──

type Tipo = 'marca' | 'contexto';

const ROTULO_STATUS: Record<string, { tone: 'success' | 'danger' | 'warning'; label: string }> = {
  approved: { tone: 'success', label: 'Aprovado' },
  rejected: { tone: 'danger', label: 'Rejeitado' },
  draft: { tone: 'warning', label: 'Rascunho' },
};

export function PerfisTab({ tipo, catalog }: { tipo: Tipo; catalog: Catalog | null }) {
  const [kind, setKind] = useState<ProfileKind>(tipo === 'marca' ? 'brand-kits' : 'context-profiles');
  const [linhas, setLinhas] = useState<ProfileRow[] | null>(null);
  const [erroCarga, setErroCarga] = useState('');
  const [editando, setEditando] = useState<ProfileRow | null>(null);
  // Todos os tipos usam formulário guiado; o contador remonta o editor a cada "Novo".
  const [aberto, setAberto] = useState(false);
  const [novoCont, setNovoCont] = useState(0);
  const contexto = kind === 'context-profiles';

  const carregar = useCallback(() => {
    setErroCarga('');
    setLinhas(null);
    listProfiles(kind).then((r) => setLinhas(r.items)).catch((e: Error) => setErroCarga(e.message));
  }, [kind]);
  useEffect(carregar, [carregar]);

  function novo() {
    setEditando(null);
    setNovoCont((n) => n + 1);
    setAberto(true);
  }

  function fechar() {
    setAberto(false);
    setEditando(null);
  }

  const nome = (r: ProfileRow) => String(r.data.name || (r.data.subject as { name?: string } | undefined)?.name || r.id);
  const columns: Column<ProfileRow>[] = [
    { key: 'name', label: 'Nome', render: nome, sortValue: nome, truncate: true },
    { key: 'version', label: 'Versão', align: 'right', render: (r) => `v${r.version}` },
    ...(contexto ? [{ key: 'status', label: 'Status', render: (r: ProfileRow) => { const s = ROTULO_STATUS[r.status] ?? ROTULO_STATUS.draft; return <StatusBadge tone={s.tone} label={s.label} />; } } as Column<ProfileRow>] : []),
    { key: 'updatedAt', label: 'Atualizado', render: (r) => formatData(r.updatedAt), priority: 'low' },
    {
      key: 'acoes', label: 'Ações', hideLabel: true,
      render: (r) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => { setEditando(r); setAberto(true); }}>Editar</Button>
          <Button size="sm" variant="ghost" onClick={() => archiveProfile(kind, r.id).then(carregar).catch(() => {})}>Arquivar</Button>
        </>
      ),
    },
  ];

  const chaveEditor = editando ? `${editando.id}-${editando.version}` : `novo-${novoCont}`;
  const tituloNovo = kind === 'brand-kits' ? 'Brand Kit' : kind === 'niche-kits' ? 'Niche Kit' : 'Perfil de contexto';

  return (
    <PageStack>
      {tipo === 'marca' && (
        <RadioCardGroup<ProfileKind>
          name="kit" legend="Tipo de kit" value={kind} onChange={(v) => { setKind(v); fechar(); }}
          options={[
            { value: 'brand-kits', title: 'Brand Kit', description: 'Quem é a marca: posicionamento, público, tom de voz, visual e o que evitar.' },
            { value: 'niche-kits', title: 'Niche Kit', description: 'O mercado em que ela vende: tipos de produto, ambientes, materiais e clichês do nicho.' },
          ]}
        />
      )}
      <Card
        title={editando ? `Editar ${nome(editando)}` : tituloNovo}
        description={contexto ? 'Só perfis aprovados podem ser usados na geração. Cada salvamento gera uma nova versão.' : 'Cada salvamento gera uma nova versão. O gerador valida o kit antes de salvar.'}
        action={aberto ? undefined : <Button size="sm" variant="secondary" onClick={novo}>Novo</Button>}
      >
        {!aberto ? (
          <p>Clique em Novo para cadastrar pelo formulário guiado, com a opção de preencher pelo ChatGPT.</p>
        ) : contexto ? (
          <ContextoEditor
            key={chaveEditor}
            inicial={editando ? editando.data : null}
            statusInicial={editando ? editando.status : 'draft'}
            editando={editando ? { id: editando.id, version: editando.version } : null}
            onSalvo={() => { fechar(); carregar(); }}
            onDescartar={fechar}
          />
        ) : (
          <KitEditor
            key={chaveEditor}
            kind={kind as KitKind}
            catalog={catalog}
            inicial={editando ? editando.data : null}
            editando={editando ? { id: editando.id, version: editando.version } : null}
            onSalvo={() => { fechar(); carregar(); }}
            onDescartar={fechar}
          />
        )}
      </Card>
      {erroCarga && <ErrorState description={erroCarga} onRetry={carregar} />}
      {!erroCarga && !linhas && <Skeleton variant="table" rows={3} />}
      {linhas && linhas.length === 0 && <EmptyState title="Nada cadastrado" description="Cadastros deste tipo aparecem aqui com a versão atual." />}
      {linhas && linhas.length > 0 && <DataTable label="Cadastros" columns={columns} rows={linhas} rowKey={(r) => r.id} />}
    </PageStack>
  );
}

// ── Personas ──────────────────────────────────────────────────────────────

export function PersonasTab({ catalog }: { catalog: Catalog | null }) {
  const [linhas, setLinhas] = useState<ProfileRow[] | null>(null);
  const [erroCarga, setErroCarga] = useState('');
  const [editando, setEditando] = useState<ProfileRow | null>(null);
  const [aberto, setAberto] = useState(false);
  const [novoCont, setNovoCont] = useState(0);

  const carregar = useCallback(() => {
    setErroCarga('');
    listProfiles('personas').then((r) => setLinhas(r.items)).catch((e: Error) => setErroCarga(e.message));
  }, []);
  useEffect(carregar, [carregar]);

  function novo() {
    setEditando(null);
    setNovoCont((n) => n + 1);
    setAberto(true);
  }

  function fechar() {
    setAberto(false);
    setEditando(null);
  }

  const columns: Column<ProfileRow>[] = [
    { key: 'label', label: 'Persona', render: (r) => String(r.data.label), sortValue: (r) => String(r.data.label), truncate: true },
    { key: 'version', label: 'Versão', align: 'right', render: (r) => `v${r.version}`, priority: 'low' },
    { key: 'age', label: 'Idade', render: (r) => String(r.data.age_range || '—'), priority: 'low' },
    { key: 'style', label: 'Estilo', render: (r) => String(r.data.style || '—'), priority: 'low', truncate: true },
    {
      key: 'acoes', label: 'Ações', hideLabel: true,
      render: (r) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => { setEditando(r); setAberto(true); }}>Editar</Button>
          <Button size="sm" variant="ghost" onClick={() => archiveProfile('personas', r.id).then(carregar).catch(() => {})}>Arquivar</Button>
        </>
      ),
    },
  ];

  return (
    <PageStack>
      <Card
        title={editando ? `Editar ${String(editando.data.label)}` : 'Persona'}
        description="Sem persona cadastrada, o gerador usa as sugeridas pelo Brand Kit ou Niche Kit. Cada salvamento gera uma nova versão."
        action={aberto ? undefined : <Button size="sm" variant="secondary" onClick={novo}>Novo</Button>}
      >
        {aberto ? (
          <PersonaEditor
            key={editando ? `${editando.id}-${editando.version}` : `novo-${novoCont}`}
            catalog={catalog}
            inicial={editando ? editando.data : null}
            editando={editando ? { id: editando.id, version: editando.version } : null}
            onSalvo={() => { fechar(); carregar(); }}
            onDescartar={fechar}
          />
        ) : (
          <p>Clique em Novo para cadastrar pelo formulário guiado, com a opção de preencher pelo ChatGPT.</p>
        )}
      </Card>
      {erroCarga && <ErrorState description={erroCarga} onRetry={carregar} />}
      {!erroCarga && !linhas && <Skeleton variant="table" rows={3} />}
      {linhas && linhas.length === 0 && <EmptyState title="Nenhuma persona" description="Personas cadastradas podem ser escolhidas na aba Gerar." />}
      {linhas && linhas.length > 0 && <DataTable label="Personas" columns={columns} rows={linhas} rowKey={(r) => r.id} />}
    </PageStack>
  );
}
