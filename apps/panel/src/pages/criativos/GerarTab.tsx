import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Field,
  FormActions,
  FormGrid,
  FormSection,
  FormStack,
  Input,
  RadioCardGroup,
  Select,
  Disclosure,
  StatusBadge,
  Switch,
  Textarea,
} from '../../components/ds';
import {
  createJob,
  generateCopies,
  listProducts,
  listProfiles,
  previewJob,
  type AcaoCena,
  type Catalog,
  type CenaPessoa,
  type CopiaDados,
  type CriativosStatus,
  type Engine,
  type FunnelStage,
  type JobInput,
  type PlanSummary,
  type PromptPrevia,
  type Product,
  type ProductMode,
  type ProfileRow,
  type RemarketingIntent,
} from '../../api/criativos';
import { plural } from '../../lib/format';
import { PromptsPrevia } from './PromptsPrevia';

const ENGINE_LABEL: Record<Engine, { title: string; description: string }> = {
  CLEAN_ANGLES: { title: 'Ângulos Limpos', description: 'Imagem pura: produto + contexto + ângulo. O funil fica na copy do anúncio.' },
  REMARKETING: { title: 'Remarketing', description: 'Para quem já conhece a marca: mensagem pela intenção, com headline e CTA na arte.' },
  FUNNEL_VISUAL: { title: 'Funil por Criativo', description: 'TOFU, MOFU ou BOFU na arte: headline, CTA, selos e benefícios por etapa.' },
};

const INTENT_LABEL: Record<RemarketingIntent, string> = {
  site_visitor: 'Visitante do site',
  product_view: 'Produto visto',
  collection_discovery: 'Coleção',
  cart: 'Carrinho',
  checkout: 'Checkout',
  social_proof: 'Prova social',
  objection: 'Objeção',
};

const linhas = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);

// "Copiar dados": o que o formulário sabe editar. O resto do que veio (chaves que a tela não mostra) volta intacto no pedido.
const CHAVES_REMARKETING = ['intent', 'headline', 'subheadline', 'cta', 'benefits', 'text_density', 'cta_emphasis', 'clean_mode', 'products_source'];
const CHAVES_FUNIL = ['headline', 'subheadline', 'cta', 'benefits', 'badges', 'chips', 'search_bar_text', 'text_density', 'cta_emphasis', 'clean_mode'];
const restoDe = (obj: Record<string, unknown> | undefined, conhecidas: string[]) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !conhecidas.includes(k)));
const texto_de = (v: unknown) => (typeof v === 'string' ? v : '');
const lista_de = (v: unknown) => (Array.isArray(v) ? v.map(String).join('\n') : '');

const CAMPO_INDISPONIVEL: Record<string, string> = {
  product: 'Produto', brand: 'Marca', niche: 'Nicho', persona: 'Persona', context: 'Contexto', subjects: 'Pessoas e interação', scene_picks: 'Sorteios da cena',
};
const MOTIVO_INDISPONIVEL: Record<string, string> = {
  missing_or_archived: 'não existe mais ou foi arquivado',
  no_reference: 'está sem imagem de referência',
  plan_v2_not_enabled: 'exige o plano v2, que ainda não está habilitado nesta conta',
  prompt_v2_not_enabled: 'exige o prompt v2, que ainda não está habilitado nesta conta',
  geographic_subject_unknown: 'a cidade do lote original não foi guardada',
};

// A tela nunca mostra idade: o texto livre da persona pode trazê-la ("menina 7 anos"), então ela sai do resumo.
const semIdade = (t: string) => t.replace(/\s*\d+\s*anos?\b/gi, '').trim();
const capitalizar = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export function GerarTab({ status, catalog, copia, onCopiaLida, onJobCriado }: {
  status: CriativosStatus;
  catalog: Catalog;
  copia?: CopiaDados | null;
  onCopiaLida?: () => void;
  onJobCriado: (jobId: string) => void;
}) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [productMode, setProductMode] = useState<ProductMode>('single_product');
  const [produtos, setProdutos] = useState<Product[]>([]);
  const [marcas, setMarcas] = useState<ProfileRow[]>([]);
  const [nichos, setNichos] = useState<ProfileRow[]>([]);
  const [contextos, setContextos] = useState<ProfileRow[]>([]);
  const [personas, setPersonas] = useState<ProfileRow[]>([]);
  const [cargaErro, setCargaErro] = useState('');

  const [productIds, setProductIds] = useState<string[]>([]);
  const [angles, setAngles] = useState<string[]>([]);
  const [placements, setPlacements] = useState<string[]>(['FEED_4X5']);
  const [quantity, setQuantity] = useState(1);
  const [quality, setQuality] = useState('medium');
  const [brand, setBrand] = useState('');
  const [niche, setNiche] = useState('');
  const [personaMode, setPersonaMode] = useState<'automatic' | 'custom' | 'none'>('automatic');
  const [personaId, setPersonaId] = useState('');
  const [contextMode, setContextMode] = useState<'automatic' | 'geographic' | 'niche' | 'custom'>('automatic');
  const [contextProfileId, setContextProfileId] = useState('');
  const [geo, setGeo] = useState({ context_id: '', city: '', state: '' });

  const [stage, setStage] = useState<FunnelStage>('TOFU');
  const [intent, setIntent] = useState<RemarketingIntent>('site_visitor');
  const [basket, setBasket] = useState(false);
  const [texto, setTexto] = useState({ headline: '', subheadline: '', cta: '', benefits: '', badges: '', chips: '', search: '', density: '', emphasis: '', cleanMode: '' });
  const [copyGerar, setCopyGerar] = useState(false);

  // Dados copiados de um criativo: cena (pessoas + interação) e opções que a tela não edita seguem no pedido.
  const [origem, setOrigem] = useState<CopiaDados | null>(null);
  const [cena, setCena] = useState<{ subjects?: CenaPessoa[]; interaction?: string } | null>(null);
  const [extras, setExtras] = useState<{ remarketing?: Record<string, unknown>; funnel?: Record<string, unknown> }>({});

  const [preview, setPreview] = useState<{ total: number; first: PlanSummary; prompts: PromptPrevia[]; promptsOmitidos: number } | null>(null);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [copies, setCopies] = useState<{ funnel_stage: string; primary_text: string; headline: string; description: string }[]>([]);

  useEffect(() => {
    Promise.all([listProducts(), listProfiles('brand-kits'), listProfiles('niche-kits'), listProfiles('context-profiles'), listProfiles('personas')])
      .then(([p, b, n, c, pe]) => {
        setProdutos(p.items);
        setMarcas(b.items);
        setNichos(n.items);
        setContextos(c.items.filter((x) => x.status === 'approved'));
        setPersonas(pe.items);
      })
      .catch((e: Error) => setCargaErro(e.message));
  }, []);

  // Aplica os dados copiados uma vez e avisa a página para não reaplicar ao voltar para a aba.
  useEffect(() => {
    if (!copia) return;
    aplicarCopia(copia);
    if (onCopiaLida) onCopiaLida();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copia]);

  function aplicarCopia(c: CopiaDados) {
    const f = c.form;
    setOrigem(c);
    setEngine(f.engine ?? null);
    setProductMode(f.product_mode ?? 'single_product');
    setProductIds(f.product_ids ?? []);
    setAngles(f.angle_ids ?? []);
    setPlacements(f.placements ?? ['FEED_4X5']);
    setQuantity(1);
    setQuality(f.quality ?? 'medium');
    setBrand(f.brand ? `${f.brand.source}:${f.brand.id}` : '');
    setNiche(f.niche ? `${f.niche.source}:${f.niche.id}` : '');
    setPersonaMode(f.persona?.mode ?? 'automatic');
    setPersonaId(f.persona?.id ?? '');
    setContextMode(f.context?.mode ?? 'automatic');
    setContextProfileId(f.context?.profile_id ?? '');
    setGeo({ context_id: f.context?.context_id ?? '', city: f.context?.subject?.metadata.city ?? '', state: f.context?.subject?.metadata.state ?? '' });
    setStage(f.funnel_stage ?? 'TOFU');
    const r = f.remarketing || {};
    const fu = f.funnel || {};
    const fonte = f.engine === 'REMARKETING' ? r : fu;
    setIntent((r.intent as RemarketingIntent) ?? 'site_visitor');
    setBasket(r.products_source === 'basket');
    setCopyGerar(Boolean(f.copy?.generate));
    setTexto({
      headline: texto_de(fonte.headline), subheadline: texto_de(fonte.subheadline), cta: texto_de(fonte.cta), benefits: lista_de(fonte.benefits),
      badges: lista_de(fu.badges), chips: lista_de(fu.chips), search: texto_de(fu.search_bar_text), density: texto_de(fonte.text_density),
      emphasis: texto_de(fonte.cta_emphasis),
      cleanMode: f.engine === 'REMARKETING' ? texto_de(r.clean_mode) : fu.clean_mode === true ? 'always' : '',
    });
    setExtras({ remarketing: f.remarketing, funnel: f.funnel });
    setCena(f.subjects || f.interaction ? { subjects: f.subjects, interaction: f.interaction } : null);
    setPreview(null);
    setErro('');
  }

  const regra = engine ? catalog.multiProductRules[engine] : null;
  const multiPermitido = status.flags.creative_multi_product && Boolean(regra?.enabled);
  const limite = productMode === 'single_product' ? { min: 1, max: 1 } : { min: regra?.min ?? 2, max: regra?.max ?? 6 };

  const input: JobInput | null = useMemo(() => {
    if (!engine || !brand) return null;
    const [brandSource, brandId] = brand.split(':') as ['profile' | 'builtin', string];
    const base: JobInput = {
      engine,
      product_mode: productMode,
      product_ids: productIds,
      angle_ids: angles,
      placements,
      quantity,
      quality,
      brand: { source: brandSource, id: brandId },
      persona: personaMode === 'custom' ? { mode: 'custom', id: personaId } : { mode: personaMode },
      context: { mode: contextMode },
    };
    if (niche) {
      const [s, id] = niche.split(':') as ['profile' | 'builtin', string];
      base.niche = { source: s, id };
    }
    if (contextMode === 'custom') base.context.profile_id = contextProfileId;
    if (contextMode === 'geographic') {
      base.context.context_id = geo.context_id;
      base.context.subject = { name: geo.city || geo.state, metadata: { city: geo.city, state: geo.state } };
    }
    const comuns: Record<string, unknown> = {};
    if (texto.headline) comuns.headline = texto.headline;
    if (texto.subheadline) comuns.subheadline = texto.subheadline;
    if (texto.cta) comuns.cta = texto.cta;
    if (texto.benefits) comuns.benefits = linhas(texto.benefits);
    if (texto.density) comuns.text_density = texto.density;
    if (texto.emphasis) comuns.cta_emphasis = texto.emphasis;
    if (engine === 'CLEAN_ANGLES') {
      base.copy = { generate: copyGerar };
    }
    if (cena?.subjects?.length) base.subjects = cena.subjects;
    if (cena?.interaction) base.interaction = cena.interaction;
    if (engine === 'REMARKETING') {
      base.remarketing = { ...restoDe(extras.remarketing, CHAVES_REMARKETING), intent, ...comuns, ...(basket ? { products_source: 'basket' } : {}), ...(texto.cleanMode ? { clean_mode: texto.cleanMode } : {}) };
    }
    if (engine === 'FUNNEL_VISUAL') {
      base.funnel_stage = stage;
      base.funnel = {
        ...restoDe(extras.funnel, CHAVES_FUNIL),
        ...comuns,
        ...(texto.badges ? { badges: linhas(texto.badges) } : {}),
        ...(texto.chips ? { chips: linhas(texto.chips) } : {}),
        ...(texto.search ? { search_bar_text: texto.search } : {}),
        ...(texto.cleanMode ? { clean_mode: texto.cleanMode === 'always' } : {}),
      };
    }
    return base;
  }, [engine, productMode, productIds, angles, placements, quantity, quality, brand, niche, personaMode, personaId, contextMode, contextProfileId, geo, texto, stage, intent, basket, copyGerar, cena, extras]);

  const prontoParaPrevia = Boolean(input && productIds.length >= limite.min && productIds.length <= limite.max && angles.length && placements.length);
  const total = angles.length * placements.length * quantity;

  function limparResultado() {
    setPreview(null);
    setErro('');
  }

  function alternar(lista: string[], valor: string, set: (v: string[]) => void, max = Infinity) {
    limparResultado();
    if (lista.includes(valor)) set(lista.filter((v) => v !== valor));
    else if (lista.length < max) set([...lista, valor]);
  }

  function escolherModo(modo: ProductMode) {
    setProductMode(modo);
    setProductIds([]);
    limparResultado();
  }

  // "Recomendado: Menina + pai · brincando juntos · sala". Só nomes de tela: sem idade, risco, ids de relação ou política.
  const resumoCena = useMemo(() => {
    const pessoas = cena?.subjects;
    if (!pessoas || pessoas.length < 2) return null;
    const relacao = (p: CenaPessoa) => (p.relation_to_primary === 'custom' ? p.relation_label : catalog.catalog.relations?.find((r) => r.id === p.relation_to_primary)?.label);
    const nomes = pessoas.map((p, i) => (i === 0 ? semIdade(p.persona.label) : (relacao(p) ?? semIdade(p.persona.label))).toLowerCase());
    const interacao = catalog.catalog.interactions?.find((i) => i.id === cena?.interaction)?.label;
    const contextoNome = contextMode === 'custom' ? String((contextos.find((c) => c.id === contextProfileId)?.data.subject as { name?: string } | undefined)?.name || '') : contextMode === 'geographic' ? geo.city : '';
    return [capitalizar(nomes.join(' + ')), interacao, contextoNome].filter(Boolean).join(' · ');
  }, [cena, catalog, contextMode, contextos, contextProfileId, geo.city]);

  const interacoesPossiveis = (catalog.catalog.interactions || []).filter((i) => (cena?.subjects?.length ?? 0) >= i.min_people && (cena?.subjects?.length ?? 0) <= i.max_people);

  // Gerar direto dos dados copiados: "de novo" repete a cena (semente, sorteios, olhar); "variação" larga o que é sorteio.
  function gerarCopiado(acao: 'again' | 'variation') {
    if (!input || !origem) return;
    const remendo: AcaoCena = origem.actions[acao];
    setOcupado(true);
    setErro('');
    createJob({ ...input, ...remendo }).then((job) => onJobCriado(job.id)).catch((e: Error) => setErro(e.message)).finally(() => setOcupado(false));
  }

  function executar(acao: 'preview' | 'gerar' | 'copy') {
    if (!input) return;
    setOcupado(true);
    setErro('');
    const promessa = acao === 'preview'
      ? previewJob(input).then((r) => setPreview({ total: r.total, first: r.first, prompts: r.prompts, promptsOmitidos: r.promptsOmitidos }))
      : acao === 'copy'
        ? generateCopies(input).then((r) => setCopies(r.variants))
        : createJob(input).then((job) => onJobCriado(job.id));
    promessa.catch((e: Error) => setErro(e.message)).finally(() => setOcupado(false));
  }

  if (cargaErro) return <Callout tone="danger" title="Não foi possível carregar os cadastros">{cargaErro}</Callout>;

  return (
    <div className="criativos-layout">
      <FormStack wide onSubmit={(e) => { e.preventDefault(); executar('preview'); }}>
        <FormSection title="1. Tipo de criativo">
          <RadioCardGroup<Engine>
            name="engine"
            legend="Motor"
            hideLegend
            columns={1}
            value={engine}
            onChange={(v) => { setEngine(v); setProductMode('single_product'); setProductIds([]); limparResultado(); }}
            options={(Object.keys(ENGINE_LABEL) as Engine[]).map((e) => ({
              value: e,
              title: ENGINE_LABEL[e].title,
              description: ENGINE_LABEL[e].description,
              disabled: !status.engines.includes(e),
            }))}
          />
        </FormSection>

        {origem && (
          <Card title="Dados copiados de um criativo" description="O formulário abaixo já vem preenchido. Ajuste o que quiser ou gere direto.">
            <div className="criativos-copia">
              {origem.unavailable.length > 0 && (
                <Callout tone="warning" title="Nem tudo pôde ser copiado">
                  <ul className="criativos-copia__lista">
                    {origem.unavailable.map((u, i) => <li key={`${u.field}-${i}`}>{CAMPO_INDISPONIVEL[u.field] || u.field}: {MOTIVO_INDISPONIVEL[u.reason] || 'indisponível'}</li>)}
                  </ul>
                </Callout>
              )}
              {origem.warnings.some((w) => w.startsWith('people_count_risk')) && (
                <Callout tone="info">Cena com muitas pessoas: prefira uma pose simples e confira o resultado com atenção.</Callout>
              )}
              {resumoCena && <p className="criativos-copia__recomendado"><strong>Recomendado:</strong> {resumoCena}</p>}
              <div className="criativos-copia__acoes">
                <Button disabled={!prontoParaPrevia || ocupado || !status.openaiKey.configured} onClick={() => gerarCopiado('variation')}>Gerar assim</Button>
                <Button variant="secondary" disabled={!prontoParaPrevia || ocupado || total !== 1 || !status.openaiKey.configured} onClick={() => gerarCopiado('again')}>Gerar de novo (mesma cena)</Button>
              </div>
              {cena && (
                <Disclosure summary="Personalizar cena">
                  <ul className="criativos-copia__lista">
                    {(cena.subjects || []).map((p, i) => {
                      const rel = p.relation_to_primary === 'custom' ? p.relation_label : catalog.catalog.relations?.find((r) => r.id === p.relation_to_primary)?.label;
                      return <li key={p.id || i}>{capitalizar(semIdade(p.persona.label))}{rel ? ` · ${rel}` : ''} · {p.wears_product_id ? 'veste o produto' : 'não veste o produto'}</li>;
                    })}
                  </ul>
                  {interacoesPossiveis.length > 0 && (
                    <Field label="Interação">
                      <Select value={cena.interaction || ''} onChange={(e) => { setCena({ ...cena, interaction: e.target.value || undefined }); limparResultado(); }}>
                        <option value="">Deixar o gerador escolher</option>
                        {interacoesPossiveis.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}
                      </Select>
                    </Field>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => { setCena(null); limparResultado(); }}>Usar cena automática</Button>
                </Disclosure>
              )}
            </div>
          </Card>
        )}

        {engine && (
          <>
            <FormSection title="2. Produtos">
              <RadioCardGroup<ProductMode>
                name="product_mode"
                legend="Quantidade de produtos"
                value={productMode}
                onChange={escolherModo}
                options={[
                  { value: 'single_product', title: 'Um produto' },
                  { value: 'multi_product', title: 'Multipeça', description: multiPermitido ? `${limite.min} a ${regra?.max} produtos` : 'não habilitado nesta conta', disabled: !multiPermitido },
                ]}
              />
              {produtos.length === 0 && <Callout tone="info">Cadastre produtos na aba Produtos.</Callout>}
              <div role="group" aria-label="Produtos" className="criativos-lista-check">
                {produtos.map((p) => (
                  <Checkbox
                    key={p.id}
                    label={`${p.name} (${p.type})`}
                    description={plural(p.references.length, 'imagem de referência', 'imagens de referência')}
                    checked={productIds.includes(p.id)}
                    onChange={() => (productMode === 'single_product' ? (limparResultado(), setProductIds([p.id])) : alternar(productIds, p.id, setProductIds, limite.max))}
                  />
                ))}
              </div>
              {engine === 'REMARKETING' && productMode === 'multi_product' && (intent === 'cart' || intent === 'checkout') && (
                <Switch checked={basket} onChange={setBasket} label="Estes produtos são o carrinho/pedido real do cliente" />
              )}
            </FormSection>

            {engine === 'REMARKETING' && (
              <FormSection title="3. Intenção de remarketing">
                <Select value={intent} onChange={(e) => { setIntent(e.target.value as RemarketingIntent); limparResultado(); }} aria-label="Intenção">
                  {catalog.catalog.remarketing_intents.map((i) => <option key={i} value={i}>{INTENT_LABEL[i]}</option>)}
                </Select>
              </FormSection>
            )}
            {engine === 'FUNNEL_VISUAL' && (
              <FormSection title="3. Etapa do funil">
                <RadioCardGroup<FunnelStage>
                  name="stage" legend="Etapa" hideLegend value={stage} onChange={(v) => { setStage(v); limparResultado(); }}
                  options={[{ value: 'TOFU', title: 'TOFU', description: 'descoberta' }, { value: 'MOFU', title: 'MOFU', description: 'consideração' }, { value: 'BOFU', title: 'BOFU', description: 'decisão' }]}
                />
              </FormSection>
            )}

            <FormSection title={engine === 'CLEAN_ANGLES' ? '3. Ângulos' : '4. Ângulos'}>
              <div role="group" aria-label="Ângulos" className="criativos-lista-check">
                {catalog.catalog.angles.map((a) => (
                  <Checkbox key={a.id} label={a.label} description={a.description + (a.apparel_only ? ' (só vestuário)' : '')} checked={angles.includes(a.id)} onChange={() => alternar(angles, a.id, setAngles)} />
                ))}
              </div>
            </FormSection>

            <FormSection title="Marca, nicho, contexto e persona">
              <FormGrid>
                <Field label="Brand Kit" required>
                  <Select value={brand} onChange={(e) => { setBrand(e.target.value); limparResultado(); }}>
                    <option value="">Escolha…</option>
                    {marcas.map((m) => <option key={m.id} value={`profile:${m.id}`}>{String(m.data.name)} (v{m.version})</option>)}
                    {catalog.catalog.builtin_kits.brand.map((k) => <option key={k.id} value={`builtin:${k.id}`}>{k.name} (embutido)</option>)}
                  </Select>
                </Field>
                <Field label="Niche Kit" optional>
                  <Select value={niche} onChange={(e) => { setNiche(e.target.value); limparResultado(); }}>
                    <option value="">Padrão da marca</option>
                    {catalog.catalog.builtin_kits.niche.map((k) => <option key={k.id} value={`builtin:${k.id}`}>{k.name}</option>)}
                    {nichos.map((n) => <option key={n.id} value={`profile:${n.id}`}>{String(n.data.name)} (v{n.version})</option>)}
                  </Select>
                </Field>
                <Field label="Contexto">
                  <Select value={contextMode} onChange={(e) => { setContextMode(e.target.value as typeof contextMode); limparResultado(); }}>
                    <option value="automatic">Automático</option>
                    <option value="niche">Do nicho</option>
                    <option value="geographic">Geográfico (região)</option>
                    <option value="custom">Perfil aprovado</option>
                  </Select>
                </Field>
                <Field label="Persona">
                  <Select value={personaMode} onChange={(e) => { setPersonaMode(e.target.value as typeof personaMode); limparResultado(); }}>
                    <option value="automatic">Automática</option>
                    <option value="custom">Cadastrada</option>
                    <option value="none">Sem persona</option>
                  </Select>
                </Field>
              </FormGrid>
              {contextMode === 'custom' && (
                <Field label="Perfil de contexto (só aprovados)">
                  <Select value={contextProfileId} onChange={(e) => setContextProfileId(e.target.value)}>
                    <option value="">Escolha…</option>
                    {contextos.map((c) => <option key={c.id} value={c.id}>{String((c.data.subject as { name?: string })?.name || c.id)}</option>)}
                  </Select>
                </Field>
              )}
              {contextMode === 'geographic' && (
                <FormGrid>
                  <Field label="Região (id)" hint="ex.: vale_europeu"><Input value={geo.context_id} onChange={(e) => setGeo({ ...geo, context_id: e.target.value })} /></Field>
                  <Field label="Cidade"><Input value={geo.city} onChange={(e) => setGeo({ ...geo, city: e.target.value })} /></Field>
                  <Field label="UF"><Input maxLength={2} value={geo.state} onChange={(e) => setGeo({ ...geo, state: e.target.value.toUpperCase() })} /></Field>
                </FormGrid>
              )}
              {personaMode === 'custom' && (
                <Field label="Persona cadastrada">
                  <Select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
                    <option value="">Escolha…</option>
                    {personas.map((p) => <option key={p.id} value={p.id}>{String(p.data.label)}</option>)}
                  </Select>
                </Field>
              )}
            </FormSection>

            {engine !== 'CLEAN_ANGLES' && (
              <FormSection title="Texto na arte" description="Vazio usa o texto padrão do motor. Benefícios, selos e chips só entram se você informar.">
                <FormGrid>
                  <Field label="Headline" optional><Input maxLength={120} value={texto.headline} onChange={(e) => setTexto({ ...texto, headline: e.target.value })} /></Field>
                  <Field label="Subheadline" optional><Input maxLength={200} value={texto.subheadline} onChange={(e) => setTexto({ ...texto, subheadline: e.target.value })} /></Field>
                  <Field label="CTA" optional><Input maxLength={60} value={texto.cta} onChange={(e) => setTexto({ ...texto, cta: e.target.value })} /></Field>
                  <Field label="Densidade de texto" optional>
                    <Select value={texto.density} onChange={(e) => setTexto({ ...texto, density: e.target.value })}>
                      <option value="">Pela etapa</option>
                      {catalog.catalog.text_densities.map((d) => <option key={d} value={d}>{d}</option>)}
                    </Select>
                  </Field>
                  <Field label="Ênfase do CTA" optional>
                    <Select value={texto.emphasis} onChange={(e) => setTexto({ ...texto, emphasis: e.target.value })}>
                      <option value="">Pela etapa</option>
                      {catalog.catalog.cta_emphases.map((d) => <option key={d} value={d}>{d}</option>)}
                    </Select>
                  </Field>
                  <Field label="Modo limpo" optional>
                    <Select value={texto.cleanMode} onChange={(e) => setTexto({ ...texto, cleanMode: e.target.value })}>
                      <option value="">{engine === 'REMARKETING' ? 'Automático' : 'Desligado'}</option>
                      <option value="always">Sempre</option>
                      {engine === 'REMARKETING' && <option value="never">Nunca</option>}
                    </Select>
                  </Field>
                </FormGrid>
                <Field label="Benefícios (1 por linha, até 3)" optional><Textarea rows={3} value={texto.benefits} onChange={(e) => setTexto({ ...texto, benefits: e.target.value })} /></Field>
                {engine === 'FUNNEL_VISUAL' && stage !== 'TOFU' && (
                  <FormGrid>
                    <Field label="Selos (1 por linha)" optional><Textarea rows={2} value={texto.badges} onChange={(e) => setTexto({ ...texto, badges: e.target.value })} /></Field>
                    <Field label="Chips (1 por linha)" optional><Textarea rows={2} value={texto.chips} onChange={(e) => setTexto({ ...texto, chips: e.target.value })} /></Field>
                    <Field label="Barra de busca" optional><Input maxLength={80} value={texto.search} onChange={(e) => setTexto({ ...texto, search: e.target.value })} /></Field>
                  </FormGrid>
                )}
              </FormSection>
            )}

            <FormSection title="Formato e quantidade">
              <FormGrid>
                {catalog.catalog.placements.map((p) => (
                  <Checkbox key={p.id} label={p.label} checked={placements.includes(p.id)} onChange={() => alternar(placements, p.id, setPlacements)} />
                ))}
                <Field label="Por ângulo e formato"><Input type="number" min={1} max={5} value={quantity} onChange={(e) => { setQuantity(Math.min(5, Math.max(1, Number(e.target.value) || 1))); limparResultado(); }} /></Field>
                <Field label="Qualidade">
                  <Select value={quality} onChange={(e) => setQuality(e.target.value)}>
                    {catalog.catalog.qualities.map((q) => <option key={q} value={q}>{q}</option>)}
                  </Select>
                </Field>
              </FormGrid>
              {engine === 'CLEAN_ANGLES' && <Switch checked={copyGerar} onChange={setCopyGerar} label="Gerar copy externa (TOFU/MOFU/BOFU)" description="A imagem continua sem texto; a copy vai para o anúncio." />}
            </FormSection>

            {erro && <p className="ds-form-error" role="alert">{erro}</p>}
            <FormActions>
              {engine === 'CLEAN_ANGLES' && copyGerar && <Button variant="ghost" disabled={!prontoParaPrevia || ocupado} onClick={() => executar('copy')}>Gerar copy</Button>}
              <Button type="submit" variant="secondary" disabled={!prontoParaPrevia || ocupado}>Pré-visualizar</Button>
              <Button disabled={!preview || ocupado || !status.openaiKey.configured} onClick={() => executar('gerar')}>
                {`Gerar ${plural(total, 'criativo', 'criativos')}`}
              </Button>
            </FormActions>
          </>
        )}
      </FormStack>

      <div className="criativos-layout__preview">
      <Card title="Prévia" description="Resumo do plano do primeiro criativo do lote e o prompt de cada ângulo para testar no ChatGPT (validado no serviço, sem custo).">
        {!preview && <p>Escolha motor, produtos, ângulos e marca e clique em Pré-visualizar.</p>}
        {preview && (
          <dl className="criativos-resumo">
            <dt>Motor</dt><dd>{ENGINE_LABEL[preview.first.strategy].title}</dd>
            <dt>Produtos</dt><dd>{productIds.length} · {preview.first.product_mode === 'multi_product' ? 'Multipeça' : 'Um produto'}</dd>
            {preview.first.funnel_stage && (<><dt>Funil</dt><dd>{preview.first.funnel_stage}</dd></>)}
            {preview.first.remarketing_intent && (<><dt>Intenção</dt><dd>{INTENT_LABEL[preview.first.remarketing_intent]}</dd></>)}
            {preview.first.layout && (<><dt>Layout</dt><dd>{preview.first.layout}</dd></>)}
            <dt>Ângulo</dt><dd>{preview.first.angle?.label}</dd>
            <dt>Formato</dt><dd>{preview.first.placement}</dd>
            <dt>Cena</dt><dd>{preview.first.scene} <StatusBadge tone="info" label={preview.first.context_provider} /></dd>
            <dt>Persona</dt><dd>{preview.first.persona || '—'}</dd>
            <dt>Texto na imagem</dt>
            <dd>{preview.first.overlay.allowed ? [preview.first.overlay.headline, preview.first.overlay.subheadline, preview.first.overlay.cta].filter(Boolean).join(' · ') : 'nenhum (imagem limpa)'}</dd>
            <dt>Quantidade</dt><dd>{preview.total}</dd>
          </dl>
        )}
        {preview && preview.first.warnings.length > 0 && <Callout tone="warning" title="Avisos">{preview.first.warnings.join(', ')}</Callout>}
        {preview && <PromptsPrevia prompts={preview.prompts} omitidos={preview.promptsOmitidos} />}
        {copies.length > 0 && (
          <div>
            {copies.map((c) => (
              <Callout key={c.funnel_stage} tone="info" title={`${c.funnel_stage} — ${c.headline}`}>
                {c.primary_text}
                <br />
                <small>{c.description}</small>
              </Callout>
            ))}
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}
