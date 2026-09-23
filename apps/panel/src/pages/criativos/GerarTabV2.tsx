import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Disclosure,
  Field,
  FormActions,
  FormGrid,
  FormSection,
  FormStack,
  Input,
  Modal,
  RadioCardGroup,
  Select,
  StatusBadge,
  Textarea,
} from '../../components/ds';
import {
  createAngle,
  createJob,
  gerarSlug,
  listAngles,
  listProducts,
  listProfiles,
  previewJob,
  type AngleFamily,
  type AngleFamilyId,
  type AnglesResponse,
  type CopiaDados,
  type CriativosStatus,
  type Catalog,
  type GazeMode,
  type JobInput,
  type PlanSummary,
  type Product,
  type ProfileRow,
} from '../../api/criativos';
import { plural } from '../../lib/format';

// Fase E — UI V2 do gerador (Ângulos Limpos, produto único): "backend rico, planner inteligente, UI simples".
// A tela inicial não expõe age_band, pose_risk, semantic_context, ids de relation, provenance, compiler,
// política de menores nem JSON bruto — isso continua só no backend. Contexto/pessoas/olhar entram em
// "Personalizar cena"; o resto é 2-4 decisões: produto → recomendação real do motor → Gerar assim, ou ajustar.
//
// Remarketing e Funil por Criativo continuam só na tela V1 (aba "Gerar" quando a conta não tem a flag, ou o
// motor legado quando ela tem): a V2 simplifica exatamente o fluxo que o comando descreveu — Ângulos Limpos,
// produto único, sem headline/CTA na arte.

// ------------------------------------------------------------------ traduções (nunca a tela "entende", só rotula códigos que o motor já devolve)
const RAZAO_LABEL: Record<string, string> = {
  no_person_requested: 'sem pessoa na cena',
  single_person_default: 'uma pessoa, padrão do motor',
  'intent_hint:creator': 'estilo creator',
};
function textoRazao(reason: string[], interactions: { id: string; label: string }[]): string {
  const partes = reason.map((r) => {
    if (RAZAO_LABEL[r]) return RAZAO_LABEL[r];
    const [prefixo, valor] = r.split(':');
    if (prefixo === 'interaction') return interactions.find((i) => i.id === valor)?.label.toLowerCase() || valor;
    if (prefixo === 'people_count') return `${valor} ${Number(valor) === 1 ? 'pessoa' : 'pessoas'}`;
    if (prefixo === 'relationship_theme') return valor.replace(/_/g, ' ');
    return null;
  }).filter((v): v is string => Boolean(v));
  return partes.join(' · ');
}

const GAZE_LABEL: Record<GazeMode, string> = { camera: 'para a câmera', interaction: 'para a interação', off_camera: 'longe da câmera', product: 'para o produto' };

// A tela nunca inventa uma recomendação: só mostra quando `angle_recommendation` realmente veio do plano.
function CardSugestao({ rec, familias, interactions, ocupado, onGerarAssim, onPersonalizar }: {
  rec: PlanSummary['angle_recommendation'];
  familias: AngleFamily[];
  interactions: { id: string; label: string }[];
  ocupado: boolean;
  onGerarAssim: () => void;
  onPersonalizar: () => void;
}) {
  if (!rec || !rec.family) return null;
  const familia = familias.find((f) => f.id === rec.family);
  const razao = textoRazao(rec.reason, interactions);
  const geral = rec.source !== 'planner_default' || rec.reason.length === 0;
  return (
    <Card title="Sugestão para esta estampa">
      <p className="criativos-v2__sugestao">
        <strong>{familia?.label || rec.family}</strong>
        {razao && <> · {razao}</>}
      </p>
      {geral && <p className="criativos-v2__sugestao-nota">Sugestão geral — cadastre o significado da estampa para uma recomendação mais precisa.</p>}
      <FormActions>
        <Button disabled={ocupado} onClick={onGerarAssim}>Gerar assim</Button>
        <Button variant="secondary" disabled={ocupado} onClick={onPersonalizar}>Personalizar cena</Button>
      </FormActions>
    </Card>
  );
}

interface CriarAnguloState {
  aberto: boolean;
  name: string;
  family: AngleFamilyId | '';
  photographicDirection: string;
  description: string;
  // "Personalizar" (§8): o resto do definition, opcional.
  framing: string;
  lighting: string;
  composition: string;
  defaultGaze: GazeMode | '';
  scope: 'organization' | 'store';
  erro: string;
  ocupado: boolean;
}
const ESTADO_CRIAR_ANGULO_INICIAL: CriarAnguloState = {
  aberto: false, name: '', family: '', photographicDirection: '', description: '', framing: '', lighting: '', composition: '', defaultGaze: '', scope: 'organization', erro: '', ocupado: false,
};

export function GerarTabV2({ status, catalog, copia, onCopiaLida, onJobCriado }: {
  status: CriativosStatus;
  catalog: Catalog;
  copia?: CopiaDados | null;
  onCopiaLida?: () => void;
  onJobCriado: (jobId: string) => void;
}) {
  const familias = useMemo(() => (catalog.catalog.angle_families || []).filter((f) => !f.reserved), [catalog]);
  const interactions = catalog.catalog.interactions || [];

  const [produtos, setProdutos] = useState<Product[]>([]);
  const [marcas, setMarcas] = useState<ProfileRow[]>([]);
  const [angulos, setAngulos] = useState<AnglesResponse | null>(null);
  const [cargaErro, setCargaErro] = useState('');

  const [productId, setProductId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ total: number; first: PlanSummary } | null>(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const [personalizar, setPersonalizar] = useState(false);
  const [escolha, setEscolha] = useState<{ tipo: 'auto' } | { tipo: 'family'; family: AngleFamilyId; preset?: string } | { tipo: 'custom'; id: string }>({ tipo: 'auto' });
  const [interaction, setInteraction] = useState('');
  const [personaMode, setPersonaMode] = useState<'automatic' | 'none'>('automatic');
  const [gazeMode, setGazeMode] = useState<GazeMode | ''>('');
  const [contextMode, setContextMode] = useState<'automatic' | 'geographic' | 'niche'>('automatic');
  const [geo, setGeo] = useState({ context_id: '', city: '', state: '' });
  const [placements, setPlacements] = useState<string[]>(['FEED_4X5']);
  const [quantity, setQuantity] = useState(1);

  const [origem, setOrigem] = useState<CopiaDados | null>(null);
  const [criar, setCriar] = useState<CriarAnguloState>(ESTADO_CRIAR_ANGULO_INICIAL);

  useEffect(() => {
    Promise.all([listProducts(), listProfiles('brand-kits'), listAngles()])
      .then(([p, b, a]) => { setProdutos(p.items); setMarcas(b.items); setAngulos(a); })
      .catch((e: Error) => setCargaErro(e.message));
  }, []);

  // Copiar dados também funciona na V2: mesmo produto, mesma escolha de ângulo (custom_angle_replay_of quando
  // houver), "Gerar de novo"/"Gerar variação" continuam do jeito que já existiam.
  useEffect(() => {
    if (!copia) return;
    const f = copia.form;
    setOrigem(copia);
    setProductId((f.product_ids || [])[0] || null);
    if (f.custom_angle_replay_of) setEscolha({ tipo: 'custom', id: f.custom_angle_replay_of });
    setPlacements(f.placements || ['FEED_4X5']);
    setInteraction(f.interaction || '');
    setPersonalizar(true);
    if (onCopiaLida) onCopiaLida();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copia]);

  const brandInput = useMemo((): JobInput['brand'] | null => {
    const perfil = marcas[0];
    if (perfil) return { source: 'profile', id: perfil.id };
    const embutido = catalog.catalog.builtin_kits.brand[0];
    return embutido ? { source: 'builtin', id: embutido.id as string } : null;
  }, [marcas, catalog]);

  const anguloEscolhido = escolha.tipo === 'custom' ? [...(angulos?.organization || []), ...(angulos?.store || [])].find((a) => a.id === escolha.id) : null;

  function montarInput(): JobInput | null {
    if (!productId || !brandInput) return null;
    const base: JobInput = {
      engine: 'CLEAN_ANGLES', product_mode: 'single_product', product_ids: [productId],
      angle_ids: ['auto'], placements, quantity, quality: 'medium', brand: brandInput,
      persona: { mode: personaMode }, context: { mode: contextMode === 'geographic' ? 'geographic' : contextMode },
      copy: { generate: false },
    };
    if (contextMode === 'geographic') base.context = { mode: 'geographic', context_id: geo.context_id, subject: { name: geo.city || geo.state, metadata: { city: geo.city, state: geo.state } } };
    if (interaction) base.interaction = interaction;
    if (gazeMode) base.gaze_mode = gazeMode;
    if (escolha.tipo === 'family') base.angle_family_hint = { family: escolha.family, ...(escolha.preset ? { preset: escolha.preset } : {}) };
    else if (escolha.tipo === 'custom') base.custom_angle_id = escolha.id;
    return base;
  }

  // Ao trocar de produto: busca a recomendação REAL do motor via /preview (sem custo, sem chamar a OpenAI) —
  // nunca inventada na tela. Funciona numa geração nova, não só depois de Copiar dados.
  useEffect(() => {
    if (!productId || !brandInput || origem) return;
    setPreview(null);
    setErro('');
    setOcupado(true);
    const input: JobInput = {
      engine: 'CLEAN_ANGLES', product_mode: 'single_product', product_ids: [productId], angle_ids: ['auto'],
      placements: ['FEED_4X5'], quantity: 1, quality: 'medium', brand: brandInput, persona: { mode: 'automatic' },
      context: { mode: 'automatic' }, copy: { generate: false },
    };
    previewJob(input).then((r) => setPreview({ total: r.total, first: r.first })).catch((e: Error) => setErro(e.message)).finally(() => setOcupado(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, brandInput]);

  function gerar() {
    const input = montarInput();
    if (!input) return;
    setOcupado(true);
    setErro('');
    createJob(input).then((job) => onJobCriado(job.id)).catch((e: Error) => setErro(e.message)).finally(() => setOcupado(false));
  }

  function gerarCopiado(acao: 'again' | 'variation') {
    const input = montarInput();
    if (!input || !origem) return;
    setOcupado(true);
    setErro('');
    createJob({ ...input, ...origem.actions[acao] }).then((job) => onJobCriado(job.id)).catch((e: Error) => setErro(e.message)).finally(() => setOcupado(false));
  }

  function selecionarFamilia(family: AngleFamilyId) {
    setEscolha({ tipo: 'family', family });
  }

  async function salvarAngulo() {
    if (!criar.name.trim() || !criar.family) { setCriar((c) => ({ ...c, erro: 'nome e família são obrigatórios' })); return; }
    setCriar((c) => ({ ...c, ocupado: true, erro: '' }));
    try {
      const definition: Record<string, string | string[]> = {};
      if (criar.photographicDirection) definition.photographic_direction = criar.photographicDirection;
      if (criar.framing) definition.framing = criar.framing;
      if (criar.lighting) definition.lighting = criar.lighting;
      if (criar.composition) definition.composition = criar.composition;
      const novo = await createAngle({
        scope: criar.scope, slug: gerarSlug(criar.name), name: criar.name.trim(), family: criar.family,
        peopleMode: 'optional', description: criar.description || undefined,
        definition, defaultGaze: criar.defaultGaze || undefined,
      });
      const lista = await listAngles();
      setAngulos(lista);
      setEscolha({ tipo: 'custom', id: novo.id });
      setCriar(ESTADO_CRIAR_ANGULO_INICIAL);
    } catch (e) {
      setCriar((c) => ({ ...c, ocupado: false, erro: (e as Error).message }));
    }
  }

  if (cargaErro) return <Callout tone="danger" title="Não foi possível carregar os cadastros">{cargaErro}</Callout>;

  const outrosAngulos = [...(angulos?.organization || []), ...(angulos?.store || [])].filter((a) => a.active);
  const pronto = Boolean(productId && brandInput);
  const rec = preview?.first.angle_recommendation ?? null;

  return (
    <div className="criativos-layout">
      <FormStack wide onSubmit={(e) => e.preventDefault()}>
        <FormSection title="1. Produto">
          {produtos.length === 0 && <Callout tone="info">Cadastre produtos na aba Produtos.</Callout>}
          <div role="radiogroup" aria-label="Produto" className="criativos-lista-check">
            {produtos.map((p) => (
              <Checkbox
                key={p.id}
                label={`${p.name} (${p.type})`}
                description={plural(p.references.length, 'imagem de referência', 'imagens de referência')}
                checked={productId === p.id}
                onChange={() => { setProductId(p.id); setPersonalizar(false); setEscolha({ tipo: 'auto' }); setOrigem(null); }}
              />
            ))}
          </div>
          {!brandInput && produtos.length > 0 && <Callout tone="warning" title="Nenhum Brand Kit disponível">Cadastre um Brand Kit em "Marca e nicho" antes de gerar.</Callout>}
        </FormSection>

        {origem && (
          <Card title="Dados copiados de um criativo" description="Ajuste o que quiser ou gere direto com a mesma cena.">
            <FormActions>
              <Button disabled={!pronto || ocupado || !status.openaiKey.configured} onClick={() => gerarCopiado('variation')}>Gerar variação</Button>
              <Button variant="secondary" disabled={!pronto || ocupado || !status.openaiKey.configured} onClick={() => gerarCopiado('again')}>Gerar de novo (mesma cena)</Button>
            </FormActions>
          </Card>
        )}

        {pronto && !origem && !personalizar && (
          ocupado && !preview ? <Card title="Sugestão para esta estampa"><p>Calculando a recomendação do motor…</p></Card>
            : rec ? (
              <CardSugestao rec={rec} familias={familias} interactions={interactions} ocupado={ocupado}
                onGerarAssim={gerar} onPersonalizar={() => { if (rec.family) setEscolha({ tipo: 'family', family: rec.family }); setPersonalizar(true); }} />
            ) : erro ? <Callout tone="danger" title="Não foi possível calcular a recomendação">{erro}</Callout> : null
        )}

        {pronto && (personalizar || origem) && (
          <>
            <FormSection title="2. Estilo">
              <RadioCardGroup<AngleFamilyId>
                name="familia" legend="Família do ângulo" hideLegend columns={2}
                // Um ângulo personalizado selecionado não é "desta família" para fins de escolha — mostrar um
                // cartão marcado ao lado do checkbox do ângulo pareceria duas escolhas conflitantes.
                value={escolha.tipo === 'family' ? escolha.family : escolha.tipo === 'auto' ? rec?.family ?? null : null}
                onChange={selecionarFamilia}
                options={familias.map((f) => ({ value: f.id, title: f.label, description: f.description }))}
              />
              <Disclosure summary="Outros estilos (ângulos personalizados desta conta)">
                {outrosAngulos.length === 0 && <p>Nenhum ângulo personalizado cadastrado ainda.</p>}
                <div role="radiogroup" aria-label="Ângulo personalizado" className="criativos-lista-check">
                  {outrosAngulos.map((a) => (
                    <Checkbox key={a.id} label={a.name} description={`${familias.find((f) => f.id === a.family)?.label || a.family}${a.scope === 'store' ? ' · desta Store' : ' · da Organization'}`}
                      checked={escolha.tipo === 'custom' && escolha.id === a.id} onChange={() => setEscolha({ tipo: 'custom', id: a.id })} />
                  ))}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setCriar((c) => ({ ...c, aberto: true }))}>+ Criar ângulo personalizado</Button>
              </Disclosure>
            </FormSection>

            <FormSection title="3. Personalizar cena">
              <FormGrid>
                <Field label="Interação" optional>
                  <Select value={interaction} onChange={(e) => setInteraction(e.target.value)}>
                    <option value="">Deixar o gerador escolher</option>
                    {interactions.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                  </Select>
                </Field>
                <Field label="Pessoas">
                  <Select value={personaMode} onChange={(e) => setPersonaMode(e.target.value as typeof personaMode)}>
                    <option value="automatic">Com pessoa (automático)</option>
                    <option value="none">Sem pessoa</option>
                  </Select>
                </Field>
                <Field label="Ambiente" optional>
                  <Select value={contextMode} onChange={(e) => setContextMode(e.target.value as typeof contextMode)}>
                    <option value="automatic">Automático</option>
                    <option value="niche">Do nicho</option>
                    <option value="geographic">Geográfico (região)</option>
                  </Select>
                </Field>
                <Field label="Olhar" optional>
                  <Select value={gazeMode} onChange={(e) => setGazeMode(e.target.value as GazeMode | '')}>
                    <option value="">Automático</option>
                    {(Object.keys(GAZE_LABEL) as GazeMode[]).map((g) => <option key={g} value={g}>{GAZE_LABEL[g]}</option>)}
                  </Select>
                </Field>
              </FormGrid>
              {contextMode === 'geographic' && (
                <FormGrid>
                  <Field label="Região (id)" hint="ex.: vale_europeu"><Input value={geo.context_id} onChange={(e) => setGeo({ ...geo, context_id: e.target.value })} /></Field>
                  <Field label="Cidade"><Input value={geo.city} onChange={(e) => setGeo({ ...geo, city: e.target.value })} /></Field>
                  <Field label="UF"><Input maxLength={2} value={geo.state} onChange={(e) => setGeo({ ...geo, state: e.target.value.toUpperCase() })} /></Field>
                </FormGrid>
              )}
              <Disclosure summary="Avançado">
                <FormGrid>
                  {catalog.catalog.placements.map((p) => (
                    <Checkbox key={p.id} label={p.label} checked={placements.includes(p.id)} onChange={() => setPlacements((l) => (l.includes(p.id) ? l.filter((v) => v !== p.id) : [...l, p.id]))} />
                  ))}
                  <Field label="Quantidade"><Input type="number" min={1} max={5} value={quantity} onChange={(e) => setQuantity(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} /></Field>
                </FormGrid>
              </Disclosure>
            </FormSection>

            {erro && <p className="ds-form-error" role="alert">{erro}</p>}
            {!origem && (
              <FormActions>
                <Button disabled={!placements.length || ocupado || !status.openaiKey.configured} onClick={gerar}>
                  {`Gerar ${plural(quantity, 'criativo', 'criativos')}`}
                </Button>
              </FormActions>
            )}
          </>
        )}
      </FormStack>

      <div className="criativos-layout__preview">
        <Card title="Prévia" description="Resumo do plano do primeiro criativo.">
          {!preview && !rec && <p>Escolha um produto para ver a recomendação.</p>}
          {preview && (
            <dl className="criativos-resumo">
              <dt>Ângulo</dt><dd>{preview.first.angle?.label}</dd>
              {rec?.family && <><dt>Família</dt><dd>{familias.find((f) => f.id === rec.family)?.label || rec.family}</dd></>}
              {anguloEscolhido && <><dt>Ângulo personalizado</dt><dd>{anguloEscolhido.name} (v{anguloEscolhido.version})</dd></>}
              <dt>Formato</dt><dd>{preview.first.placement}</dd>
              <dt>Cena</dt><dd>{preview.first.scene} <StatusBadge tone="info" label={preview.first.context_provider} /></dd>
              <dt>Persona</dt><dd>{preview.first.persona || '—'}</dd>
            </dl>
          )}
          {preview && preview.first.warnings.length > 0 && <Callout tone="warning" title="Avisos">{preview.first.warnings.join(', ')}</Callout>}
        </Card>
      </div>

      <Modal
        open={criar.aberto}
        onClose={() => setCriar(ESTADO_CRIAR_ANGULO_INICIAL)}
        title="Criar ângulo personalizado"
        confirmLabel="Salvar"
        confirmDisabled={criar.ocupado || !criar.name.trim() || !criar.family}
        onConfirm={salvarAngulo}
      >
        <FormGrid>
          <Field label="Nome do estilo" required><Input value={criar.name} onChange={(e) => setCriar((c) => ({ ...c, name: e.target.value }))} maxLength={120} /></Field>
          <Field label="Família" required>
            <Select value={criar.family} onChange={(e) => setCriar((c) => ({ ...c, family: e.target.value as AngleFamilyId }))}>
              <option value="">Escolha…</option>
              {familias.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </Select>
          </Field>
        </FormGrid>
        <Field label="Como você quer que a fotografia pareça?" optional hint="Um texto curto — vira a direção fotográfica do prompt.">
          <Textarea rows={2} maxLength={200} value={criar.photographicDirection} onChange={(e) => setCriar((c) => ({ ...c, photographicDirection: e.target.value }))} />
        </Field>
        <Field label="Descrição" optional><Textarea rows={2} maxLength={2000} value={criar.description} onChange={(e) => setCriar((c) => ({ ...c, description: e.target.value }))} /></Field>
        <Disclosure summary="Personalizar">
          <FormGrid>
            <Field label="Enquadramento" optional><Input maxLength={200} value={criar.framing} onChange={(e) => setCriar((c) => ({ ...c, framing: e.target.value }))} /></Field>
            <Field label="Iluminação" optional><Input maxLength={200} value={criar.lighting} onChange={(e) => setCriar((c) => ({ ...c, lighting: e.target.value }))} /></Field>
            <Field label="Composição" optional><Input maxLength={200} value={criar.composition} onChange={(e) => setCriar((c) => ({ ...c, composition: e.target.value }))} /></Field>
            <Field label="Olhar" optional>
              <Select value={criar.defaultGaze} onChange={(e) => setCriar((c) => ({ ...c, defaultGaze: e.target.value as GazeMode | '' }))}>
                <option value="">Sem preferência (a cena decide)</option>
                {(Object.keys(GAZE_LABEL) as GazeMode[]).map((g) => <option key={g} value={g}>{GAZE_LABEL[g]}</option>)}
              </Select>
            </Field>
            <Field label="Escopo">
              <Select value={criar.scope} onChange={(e) => setCriar((c) => ({ ...c, scope: e.target.value as 'organization' | 'store' }))}>
                <option value="organization">Organization (todas as Stores)</option>
                <option value="store">Só esta Store</option>
              </Select>
            </Field>
          </FormGrid>
        </Disclosure>
        {criar.erro && <p className="ds-form-error" role="alert">{criar.erro}</p>}
      </Modal>
    </div>
  );
}
