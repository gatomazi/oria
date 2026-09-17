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
  type Catalog,
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

export function GerarTab({ status, catalog, onJobCriado }: { status: CriativosStatus; catalog: Catalog; onJobCriado: (jobId: string) => void }) {
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
    if (engine === 'REMARKETING') {
      base.remarketing = { intent, ...comuns, ...(basket ? { products_source: 'basket' } : {}), ...(texto.cleanMode ? { clean_mode: texto.cleanMode } : {}) };
    }
    if (engine === 'FUNNEL_VISUAL') {
      base.funnel_stage = stage;
      base.funnel = {
        ...comuns,
        ...(texto.badges ? { badges: linhas(texto.badges) } : {}),
        ...(texto.chips ? { chips: linhas(texto.chips) } : {}),
        ...(texto.search ? { search_bar_text: texto.search } : {}),
        ...(texto.cleanMode ? { clean_mode: texto.cleanMode === 'always' } : {}),
      };
    }
    return base;
  }, [engine, productMode, productIds, angles, placements, quantity, quality, brand, niche, personaMode, personaId, contextMode, contextProfileId, geo, texto, stage, intent, basket, copyGerar]);

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
