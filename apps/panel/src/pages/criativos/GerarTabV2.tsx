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
  Switch,
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
  type CenaPessoa,
  type CopiaDados,
  type CriativosStatus,
  type Catalog,
  type Engine,
  type FunnelStage,
  type GazeMode,
  type JobInput,
  type PlanSummary,
  type Product,
  type ProductMode,
  type ProfileRow,
  type RemarketingIntent,
} from '../../api/criativos';
import { plural } from '../../lib/format';
import { ENGINE_LABEL, FUNNEL_STAGE_LABEL, INTENT_DESCRICAO, INTENT_LABEL, type TextoMotor } from './criativosMotores';
import {
  CHAVES_FUNIL, CHAVES_REMARKETING, funnelOptions, intentsDisponiveis, limiteDeProdutos, lista_de, MAX_SUBJECTS_EDITAVEIS,
  overridesAoTrocarDeMotor, remarketingOptions, restoDe, subjectsComOverride, texto_de, textoAviso, TEXTO_MOTOR_VAZIO,
} from './criativosMotorInput.mjs';

// Fase E — UI V2 do gerador (Ângulos Limpos, produto único): "backend rico, planner inteligente, UI simples".
// A tela inicial não expõe age_band, pose_risk, semantic_context, ids de relation, provenance, compiler,
// política de menores nem JSON bruto — isso continua só no backend. Contexto/pessoas/olhar entram em
// "Personalizar cena"; o resto é poucas decisões: motor → produto(s) → objetivo (Remarketing/Funil) →
// recomendação real do motor → Gerar assim, ou ajustar.
//
// Fase G.1 — Remarketing e Funil por Criativo entram na MESMA experiência (este arquivo), não mais só
// em GerarTab.tsx (V1). V1 não foi tocada — quem não tem a flag `uiV2` continua vendo o formulário
// antigo, com os três motores, como sempre.
//
// Fase G.2 — Multipeça: mesmo fluxo, mais de um produto. A atribuição de "quem veste o quê" é SEMPRE a
// que o motor calculou de verdade (nunca inventada aqui) — "Quem veste o quê" em Personalizar só deixa
// AJUSTAR a atribuição real, pré-preenchida com ela, nunca começa em branco.

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

// Resumo do overlay (headline/subheadline/CTA) tal como o motor realmente calculou — nunca inventado na
// tela. `null`/vazio = "nenhum texto na arte" (Ângulos Limpos, ou modo limpo ativo).
function resumoOverlay(overlay: PlanSummary['overlay']): string | null {
  if (!overlay.allowed) return null;
  const partes = [overlay.headline, overlay.subheadline, overlay.cta].filter(Boolean);
  return partes.length ? partes.join(' · ') : null;
}

// A tela nunca inventa uma recomendação: só mostra quando o preview de fato veio do motor.
function CardSugestao({ rec, familias, interactions, preview, ocupado, onGerarAssim, onPersonalizar }: {
  rec: PlanSummary['angle_recommendation'];
  familias: AngleFamily[];
  interactions: { id: string; label: string }[];
  preview: PlanSummary;
  ocupado: boolean;
  onGerarAssim: () => void;
  onPersonalizar: () => void;
}) {
  const familia = rec?.family ? familias.find((f) => f.id === rec.family) : null;
  const razao = rec ? textoRazao(rec.reason, interactions) : '';
  const geral = !rec || rec.source !== 'planner_default' || rec.reason.length === 0;
  const overlay = resumoOverlay(preview.overlay);
  const subjects = preview.subjects || [];
  return (
    <Card title="Sugestão para esta estampa">
      {familia && (
        <p className="criativos-v2__sugestao">
          <strong>{familia.label}</strong>
          {razao && <> · {razao}</>}
        </p>
      )}
      {overlay && (
        <p className="criativos-v2__sugestao-nota">
          <strong>Texto na arte:</strong> {overlay}
        </p>
      )}
      {subjects.length >= 2 && (
        <ul className="criativos-copia__lista">
          {subjects.map((s) => (
            <li key={String(s.id)}>{String(s.persona?.label || 'Pessoa')} veste {s.product_name ? <strong>{String(s.product_name)}</strong> : 'nenhuma peça (apoio)'}</li>
          ))}
        </ul>
      )}
      {geral && <p className="criativos-v2__sugestao-nota">Sugestão geral — cadastre o significado da estampa para uma recomendação mais precisa.</p>}
      {/* Achado real de uso: os Avisos já aparecem no painel "Prévia" ao lado (sempre visível, tanto
          aqui quanto em Personalizar) — mostrar de novo aqui duplicava o mesmo aviso na tela inteira. */}
      <FormActions>
        <Button disabled={ocupado} onClick={onGerarAssim}>Gerar assim</Button>
        <Button variant="secondary" disabled={ocupado} onClick={onPersonalizar}>Personalizar</Button>
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
  const motoresDisponiveis = (Object.keys(ENGINE_LABEL) as Engine[]).filter((e) => status.engines.includes(e));

  const [produtos, setProdutos] = useState<Product[]>([]);
  const [marcas, setMarcas] = useState<ProfileRow[]>([]);
  const [angulos, setAngulos] = useState<AnglesResponse | null>(null);
  const [cargaErro, setCargaErro] = useState('');

  const [engine, setEngine] = useState<Engine | null>(motoresDisponiveis.length === 1 ? motoresDisponiveis[0] : null);
  const [productMode, setProductMode] = useState<ProductMode>('single_product');
  const [productIds, setProductIds] = useState<string[]>([]);
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

  // G.1 — Objetivo (só Remarketing/Funil) e o texto/CTA de "Personalizar" (idem). Ângulos Limpos nunca
  // usa nenhum dos dois: o motor não aceita `remarketing`/`funnel` (o core recusa com INVALID_INPUT).
  const [intent, setIntent] = useState<RemarketingIntent>('site_visitor');
  const [stage, setStage] = useState<FunnelStage>('TOFU');
  const [texto, setTexto] = useState<TextoMotor>(TEXTO_MOTOR_VAZIO);
  const [extras, setExtras] = useState<{ remarketing?: Record<string, unknown>; funnel?: Record<string, unknown> }>({});
  // G.2 — "quem veste o quê": vazio = nenhuma edição humana, o request não carrega `subjects`
  // nenhum (o core decide sozinho). Chave = `subject.id` da prévia mais recente; valor = o
  // `wears_product_id` escolhido (string) ou `null` para "sem peça — apoio".
  const [overridesElenco, setOverridesElenco] = useState<Record<string, string | null>>({});
  // G.2 — `cart`/`checkout` multipeça exigem `products_source:"basket"` no core (REMARKETING_BASKET_
  // INTENTS): "vários produtos avulsos" e "o carrinho/pedido real do cliente" são coisas diferentes
  // para o motor. Mesma pergunta que a V1 já faz, mesmo texto.
  const [cesta, setCesta] = useState(false);

  const [origem, setOrigem] = useState<CopiaDados | null>(null);
  const [criar, setCriar] = useState<CriarAnguloState>(ESTADO_CRIAR_ANGULO_INICIAL);

  useEffect(() => {
    Promise.all([listProducts(), listProfiles('brand-kits'), listAngles()])
      .then(([p, b, a]) => { setProdutos(p.items); setMarcas(b.items); setAngulos(a); })
      .catch((e: Error) => setCargaErro(e.message));
  }, []);

  // Copiar dados também funciona na V2, nos três motores: mesmo produto, mesmo motor, mesma escolha de
  // ângulo (custom_angle_replay_of quando houver) e — novo em G.1 — o mesmo objetivo/texto do criativo
  // original. "Gerar de novo"/"Gerar variação" continuam do jeito que já existiam.
  useEffect(() => {
    if (!copia) return;
    const f = copia.form;
    setOrigem(copia);
    setEngine(f.engine ?? null);
    setProductMode(f.product_mode ?? 'single_product');
    setProductIds(f.product_ids || []);
    // Consolidação — "Copiar dados" também traz "quem veste o quê" de volta quando o plano original teve
    // elenco explícito (`composition_source` "explicit"/"recommended" — o core só devolve `subjects` no
    // draft nesses casos; um plano "legacy"/automático nunca reproduz aqui, e não deveria: a prévia nova
    // recalcula a atribuição automática do zero). Os ids ("s1", "s2"...) são posicionais e batem com os
    // da prévia nova para os MESMOS product_ids, na mesma ordem.
    if (Array.isArray(f.subjects) && f.subjects.length) {
      const overrides: Record<string, string | null> = {};
      for (const s of f.subjects) {
        if (s && typeof s.id === 'string') overrides[s.id] = s.wears_product_id ?? null;
      }
      setOverridesElenco(overrides);
    } else {
      setOverridesElenco({});
    }
    if (f.custom_angle_replay_of) setEscolha({ tipo: 'custom', id: f.custom_angle_replay_of });
    setPlacements(f.placements || ['FEED_4X5']);
    setInteraction(f.interaction || '');
    const r = (f.remarketing || {}) as Record<string, unknown>;
    const fu = (f.funnel || {}) as Record<string, unknown>;
    const fonte = f.engine === 'REMARKETING' ? r : fu;
    setIntent((r.intent as RemarketingIntent) ?? 'site_visitor');
    setStage(f.funnel_stage ?? 'TOFU');
    setTexto({
      headline: texto_de(fonte.headline), subheadline: texto_de(fonte.subheadline), cta: texto_de(fonte.cta),
      benefits: lista_de(fonte.benefits), badges: lista_de(fu.badges), chips: lista_de(fu.chips), search: texto_de(fu.search_bar_text),
      density: texto_de(fonte.text_density), emphasis: texto_de(fonte.cta_emphasis),
      cleanMode: f.engine === 'REMARKETING' ? texto_de(r.clean_mode) : fu.clean_mode === true ? 'always' : '',
    });
    setExtras({ remarketing: f.remarketing as Record<string, unknown> | undefined, funnel: f.funnel as Record<string, unknown> | undefined });
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

  // G.2 — mesma fonte que a V1 já lê para o limite real de multipeça por motor (`catalog.multiProductRules`,
  // espelho de `MULTI_PRODUCT_RULES` do core — nunca um número inventado na tela).
  const regraMultipeça = engine ? catalog.multiProductRules[engine] : undefined;
  const multiPermitido = status.flags.creative_multi_product && Boolean(regraMultipeça?.enabled);
  const limiteProdutos = limiteDeProdutos(productMode, regraMultipeça);

  // A MESMA função monta tanto o request de geração quanto o de prévia — "a prévia reflete exatamente o
  // request que será enviado a /jobs" (G.1 §2) deixa de ser uma promessa e vira estruturalmente verdade:
  // não existem dois caminhos que podem divergir.
  function montarInput(): JobInput | null {
    if (!engine || !productIds.length || productIds.length < limiteProdutos.min || productIds.length > limiteProdutos.max || !brandInput) return null;
    const base: JobInput = {
      engine, product_mode: productMode, product_ids: productIds,
      angle_ids: ['auto'], placements, quantity, quality: 'medium', brand: brandInput,
      persona: { mode: personaMode }, context: { mode: contextMode === 'geographic' ? 'geographic' : contextMode },
      copy: { generate: false },
    };
    if (contextMode === 'geographic') base.context = { mode: 'geographic', context_id: geo.context_id, subject: { name: geo.city || geo.state, metadata: { city: geo.city, state: geo.state } } };
    if (interaction) base.interaction = interaction;
    if (gazeMode) base.gaze_mode = gazeMode;
    if (escolha.tipo === 'family') base.angle_family_hint = { family: escolha.family, ...(escolha.preset ? { preset: escolha.preset } : {}) };
    else if (escolha.tipo === 'custom') base.custom_angle_id = escolha.id;
    if (engine === 'REMARKETING') {
      base.remarketing = remarketingOptions(texto, intent, {
        ...restoDe(extras.remarketing, CHAVES_REMARKETING),
        ...(productMode === 'multi_product' && (intent === 'cart' || intent === 'checkout') && cesta ? { products_source: 'basket' } : {}),
      });
    }
    if (engine === 'FUNNEL_VISUAL') {
      base.funnel_stage = stage;
      base.funnel = funnelOptions(texto, stage, restoDe(extras.funnel, CHAVES_FUNIL));
    }
    // "Quem veste o quê" (G.2): só entra no request se o lojista de fato editou alguma linha — sem
    // edição, o core decide sozinho a mesma atribuição que a prévia já mostrou (nunca uma segunda
    // fonte de verdade). Baseado nos `subjects` da ÚLTIMA prévia real, nunca reconstruído à mão.
    const subjects = subjectsComOverride(preview?.first.subjects, overridesElenco);
    if (subjects) base.subjects = subjects as CenaPessoa[];
    return base;
  }

  // Um único efeito busca a recomendação/prévia REAL do motor sempre que o que ela representaria muda —
  // nunca uma segunda cópia da lógica de montagem. Pequeno atraso (não em cada tecla) só para não disparar
  // uma chamada de rede a cada caractere digitado no texto livre.
  //
  // G.1 — achado do smoke visual: `clearTimeout` só cancela o disparo ENQUANTO ele ainda não saiu — uma
  // vez que `previewJob` já está em voo, trocar de seleção de novo não cancela a promise anterior. Sem
  // guarda, uma resposta mais LENTA de uma seleção mais ANTIGA podia chegar depois de uma mais RÁPIDA de
  // uma seleção mais NOVA e sobrescrever a prévia — exatamente o que a rodada de multipeça exige nunca
  // acontecer ("respostas assíncronas antigas não devem substituir a prévia da seleção mais nova"). `ignorar`
  // marca esta execução do efeito como obsoleta assim que uma nova começa (ou o componente desmonta);
  // aplicado tanto ao sucesso quanto ao erro, para um erro antigo também não pisar num resultado novo.
  useEffect(() => {
    if (origem) return;
    const input = montarInput();
    if (!input) { setPreview(null); setOcupado(false); return; }
    setErro('');
    // `ocupado` liga JÁ AQUI, não só quando o fetch sai (dentro do setTimeout) — fecha a janela em que
    // "Gerar assim"/"Gerar N criativos" ficavam clicáveis mostrando a prévia ANTERIOR enquanto uma
    // seleção mais nova já estava agendada para buscar uma prévia diferente (achado do smoke visual).
    setOcupado(true);
    let ignorar = false;
    const temporizador = setTimeout(() => {
      previewJob(input)
        .then((r) => { if (!ignorar) setPreview({ total: r.total, first: r.first }); })
        .catch((e: Error) => {
          if (ignorar) return;
          // Achado real de uso: um erro aqui NUNCA pode deixar a prévia de uma seleção ANTERIOR visível —
          // sem isto, trocar de estilo e cair num ângulo indisponível mostrava o erro embaixo enquanto o
          // painel "Prévia" continuava com os dados do estilo anterior, como se ainda correspondessem à
          // seleção atual. `erro` e `preview` sempre trocam juntos: nunca os dois setados ao mesmo tempo.
          setPreview(null);
          setErro(e.message);
        })
        .finally(() => { if (!ignorar) setOcupado(false); });
    }, 350);
    return () => { ignorar = true; clearTimeout(temporizador); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, productMode, productIds, brandInput, escolha, interaction, personaMode, contextMode, geo, gazeMode, placements, quantity, intent, stage, texto, overridesElenco, cesta, origem]);

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

  // Troca de motor (G.1 §3): nunca transporta texto/objetivo de um motor pro outro de forma incoerente —
  // um `intent` de Remarketing não significa nada em Funil, e vice-versa. Produto, marca, família/ângulo
  // personalizado, cena e contexto SÃO preservados: são escolhas motor-agnósticas no backend (confirmado
  // na inspeção de contratos, docs/features/creative-generator-fase-g1.md §1) e continuam válidas.
  function trocarMotor(novo: Engine) {
    setEngine(novo);
    setIntent('site_visitor');
    setStage('TOFU');
    setTexto(TEXTO_MOTOR_VAZIO);
    setExtras({});
    setOverridesElenco(overridesAoTrocarDeMotor());
    setCesta(false);
    setOrigem(null);
    setPreview(null);
    setErro('');
    if (novo === 'CLEAN_ANGLES') setPersonalizar(false);
  }

  // G.2 — trocar a quantidade de produtos (Um produto/Multipeça) ou a própria seleção de produtos
  // invalida qualquer atribuição de "quem veste o quê" já feita: a cena muda de verdade (people_needed
  // pode mudar, os ids `s1`/`s2`... passam a significar outra pessoa). Nunca carrega uma edição antiga
  // para uma cena diferente em silêncio.
  function escolherModoProduto(modo: ProductMode) {
    setProductMode(modo);
    setProductIds([]);
    setOverridesElenco({});
    setCesta(false);
    setPersonalizar(false);
    setEscolha({ tipo: 'auto' });
    setOrigem(null);
    // `product_view` é só-produto-único no core (MULTI_PRODUCT_RULES.REMARKETING.singleOnlyIntents) —
    // se o lojista já tinha esse intent escolhido e muda para multipeça, ele deixa de ser uma opção
    // válida; volta ao padrão em vez de deixar o card selecionado sumir sem explicação.
    if (modo === 'multi_product' && intent === 'product_view') setIntent('site_visitor');
  }

  function alternarProduto(id: string) {
    setOverridesElenco({});
    setOrigem(null);
    if (productMode === 'single_product') { setProductIds([id]); setPersonalizar(false); setEscolha({ tipo: 'auto' }); return; }
    setProductIds((atual) => {
      if (atual.includes(id)) return atual.filter((v) => v !== id);
      if (atual.length >= limiteProdutos.max) return atual;
      return [...atual, id];
    });
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
  const pronto = Boolean(engine && productIds.length >= limiteProdutos.min && productIds.length <= limiteProdutos.max && brandInput);
  const rec = preview?.first.angle_recommendation ?? null;
  const intentsMotor = intentsDisponiveis(catalog.catalog.remarketing_intents, productMode) as RemarketingIntent[];
  // G.2 — "quem veste o quê" só faz sentido com mais de 1 pessoa na cena; com 0 ou 1, não há nada a
  // atribuir (produto único sempre foi assim; com uma família sem pessoa, `subjects` vem vazio).
  const subjectsDaPrevia = preview?.first.subjects || [];
  const produtosSelecionados = produtos.filter((p) => productIds.includes(p.id));

  return (
    <div className="criativos-layout">
      <FormStack wide onSubmit={(e) => e.preventDefault()}>
        {motoresDisponiveis.length > 1 && (
          <FormSection title="1. Tipo de criativo">
            <RadioCardGroup<Engine>
              name="engine" legend="Motor" hideLegend columns={1}
              value={engine}
              onChange={trocarMotor}
              options={motoresDisponiveis.map((e) => ({ value: e, title: ENGINE_LABEL[e].title, description: ENGINE_LABEL[e].description }))}
            />
          </FormSection>
        )}

        <FormSection title={motoresDisponiveis.length > 1 ? '2. Produto' : '1. Produto'}>
          {produtos.length === 0 && <Callout tone="info">Cadastre produtos na aba Produtos.</Callout>}
          {multiPermitido && (
            <RadioCardGroup<ProductMode>
              name="product_mode" legend="Quantidade de produtos" hideLegend columns={2}
              value={productMode}
              onChange={escolherModoProduto}
              options={[
                { value: 'single_product', title: 'Um produto' },
                { value: 'multi_product', title: 'Multipeça', description: `${limiteDeProdutos('multi_product', regraMultipeça).min} a ${limiteDeProdutos('multi_product', regraMultipeça).max} produtos` },
              ]}
            />
          )}
          <div role={productMode === 'single_product' ? 'radiogroup' : 'group'} aria-label="Produto" className="criativos-lista-check">
            {produtos.map((p) => (
              <Checkbox
                key={p.id}
                label={`${p.name} (${p.type})`}
                description={plural(p.references.length, 'imagem de referência', 'imagens de referência')}
                checked={productIds.includes(p.id)}
                disabled={productMode === 'multi_product' && !productIds.includes(p.id) && productIds.length >= limiteProdutos.max}
                onChange={() => alternarProduto(p.id)}
              />
            ))}
          </div>
          {productMode === 'multi_product' && (
            <p className="criativos-v2__sugestao-nota">
              {productIds.length} de {limiteProdutos.min} a {limiteProdutos.max} produtos escolhidos.
            </p>
          )}
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

        {pronto && engine === 'REMARKETING' && !origem && (
          <FormSection title="3. Objetivo">
            <RadioCardGroup<RemarketingIntent>
              name="intent" legend="Intenção de remarketing" hideLegend columns={1}
              value={intent}
              onChange={(v) => { setIntent(v); setPersonalizar(false); }}
              options={intentsMotor.map((i) => ({ value: i, title: INTENT_LABEL[i], description: INTENT_DESCRICAO[i] }))}
            />
            {productMode === 'multi_product' && (intent === 'cart' || intent === 'checkout') && (
              // G.2.1 — achado: `products_source:"basket"` é uma confirmação manual do lojista (o core
              // não busca nem valida um carrinho/pedido real — não existe id de carrinho no contrato).
              // Sem isso ligado, o core recusa cart/checkout em multipeça (UNSUPPORTED_PRODUCT_MODE).
              <Switch checked={cesta} onChange={setCesta} label="Estes produtos são o carrinho/pedido real do cliente"
                description="Confirmação manual sua — o gerador não verifica um carrinho ou pedido de verdade. Isso só libera as composições e o texto de carrinho/checkout." />
            )}
          </FormSection>
        )}
        {pronto && engine === 'FUNNEL_VISUAL' && !origem && (
          <FormSection title="3. Objetivo">
            <RadioCardGroup<FunnelStage>
              name="stage" legend="Etapa do funil" hideLegend columns={1}
              value={stage}
              onChange={(v) => { setStage(v); setPersonalizar(false); }}
              options={catalog.catalog.funnel_stages.map((s) => ({ value: s, title: FUNNEL_STAGE_LABEL[s].title, description: FUNNEL_STAGE_LABEL[s].description }))}
            />
          </FormSection>
        )}

        {pronto && !origem && !personalizar && (
          ocupado && !preview ? <Card title="Sugestão para esta estampa"><p>Calculando a recomendação do motor…</p></Card>
            : preview ? (
              <CardSugestao rec={rec} familias={familias} interactions={interactions} preview={preview.first} ocupado={ocupado}
                onGerarAssim={gerar} onPersonalizar={() => { if (rec?.family) setEscolha({ tipo: 'family', family: rec.family }); setPersonalizar(true); }} />
            ) : erro ? (
              // Achado real de uso: a recomendação automática (sem família escolhida) pode ser incompatível
              // com o Brand Kit (ex.: `enabledAngles` restrito, escolhido sem olhar a marca) mesmo quando
              // outra família manual funcionaria perfeitamente — antes disso travava aqui sem saída.
              <Card title="Não foi possível calcular a recomendação">
                <p>{erro}</p>
                <FormActions>
                  <Button variant="secondary" onClick={() => setPersonalizar(true)}>Escolher o estilo manualmente</Button>
                </FormActions>
              </Card>
            ) : null
        )}

        {pronto && (personalizar || origem) && (
          <>
            <FormSection title="Estilo">
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

            {(engine === 'REMARKETING' || engine === 'FUNNEL_VISUAL') && (
              <FormSection title="Texto e detalhes" description="Vazio usa o texto padrão do motor para este objetivo. Benefícios, selos e chips só entram se você informar.">
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

            {subjectsDaPrevia.length >= 2 && subjectsDaPrevia.length > MAX_SUBJECTS_EDITAVEIS && (
              // G.2.1 — achado real: o contrato aceita no máximo 4 pessoas explícitas por request
              // (core `MAX_SUBJECTS`); com 5-6 produtos numa família com pessoa, o motor já monta 5-6
              // pessoas sozinho (isso funciona — é só a EDIÇÃO manual, linha a linha, que o contrato não
              // aceita de volta). Nunca oferecemos uma edição que o backend vai recusar.
              <FormSection title="Quem veste o quê" description={`O motor montou ${subjectsDaPrevia.length} pessoas para estes produtos — acima de ${MAX_SUBJECTS_EDITAVEIS}, a atribuição individual não pode ser editada aqui (o contrato aceita no máximo ${MAX_SUBJECTS_EDITAVEIS} pessoas explícitas). A atribuição automática abaixo já é válida para gerar.`}>
                <ul className="criativos-lista-check">
                  {subjectsDaPrevia.map((s) => (
                    <li key={String(s.id)}>{String(s.persona?.label || 'Pessoa')} veste <strong>{String(s.product_name || 'nenhuma peça (apoio)')}</strong></li>
                  ))}
                </ul>
              </FormSection>
            )}

            {subjectsDaPrevia.length >= 2 && subjectsDaPrevia.length <= MAX_SUBJECTS_EDITAVEIS && (
              <FormSection title="Quem veste o quê" description="Pré-preenchido com a atribuição real do motor. Só muda no request se você editar alguma linha aqui.">
                <div className="criativos-lista-check">
                  {subjectsDaPrevia.map((s) => {
                    const idSujeito = String(s.id);
                    const atual = Object.prototype.hasOwnProperty.call(overridesElenco, idSujeito)
                      ? overridesElenco[idSujeito]
                      : (s.wears_product_id ?? null);
                    return (
                      <Field key={idSujeito} label={String(s.persona?.label || 'Pessoa')}>
                        <Select
                          value={atual ?? ''}
                          onChange={(e) => setOverridesElenco((o) => ({ ...o, [idSujeito]: e.target.value || null }))}
                        >
                          <option value="">Sem peça — apoio</option>
                          {produtosSelecionados.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                      </Field>
                    );
                  })}
                </div>
              </FormSection>
            )}

            <FormSection title="Personalizar cena">
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
                {/* Achado real de uso: a seleção atual pode não ter uma prévia válida (erro de
                    disponibilidade, ou uma nova seleção ainda não recalculada) — gerar nesse estado
                    mandaria um request que não corresponde ao que a tela mostra, ou pior, ao último
                    request que DEU CERTO para uma seleção diferente. `erro` bloqueia sempre. */}
                <Button disabled={!placements.length || ocupado || Boolean(erro) || !status.openaiKey.configured} onClick={gerar}>
                  {`Gerar ${plural(quantity, 'criativo', 'criativos')}`}
                </Button>
              </FormActions>
            )}
          </>
        )}
      </FormStack>

      <div className="criativos-layout__preview">
        <Card title="Prévia" description="Resumo do plano do primeiro criativo — sempre o mesmo request que seria enviado a /jobs.">
          {/* Achado real de uso: a prévia de uma seleção ANTERIOR nunca fica visível sob uma seleção
              NOVA que falhou — `preview` e `erro` sempre trocam juntos (mesmo efeito, acima), então aqui
              é só decidir QUAL mensagem mostrar; nunca uma dl desatualizada ao lado de um erro. */}
          {erro && !preview && (
            <Callout tone="danger" title="Prévia indisponível para esta seleção">{erro}</Callout>
          )}
          {!erro && !preview && !rec && <p>Escolha um produto{engine !== 'CLEAN_ANGLES' ? ' e um objetivo' : ''} para ver a recomendação.</p>}
          {preview && (
            <dl className="criativos-resumo">
              <dt>Produtos</dt><dd>{productIds.length} · {produtosSelecionados.map((p) => p.name).join(', ')}</dd>
              <dt>Ângulo</dt><dd>{preview.first.angle?.label}</dd>
              {rec?.family && <><dt>Família</dt><dd>{familias.find((f) => f.id === rec.family)?.label || rec.family}</dd></>}
              {anguloEscolhido && <><dt>Ângulo personalizado</dt><dd>{anguloEscolhido.name} (v{anguloEscolhido.version})</dd></>}
              {preview.first.funnel_stage && (<><dt>Etapa do funil</dt><dd>{FUNNEL_STAGE_LABEL[preview.first.funnel_stage].title} · {FUNNEL_STAGE_LABEL[preview.first.funnel_stage].description}</dd></>)}
              {preview.first.remarketing_intent && (<><dt>Intenção</dt><dd>{INTENT_LABEL[preview.first.remarketing_intent]}</dd></>)}
              {preview.first.layout && (<><dt>Layout</dt><dd>{preview.first.layout}</dd></>)}
              <dt>Formato</dt><dd>{preview.first.placement}</dd>
              <dt>Cena</dt><dd>{preview.first.scene} <StatusBadge tone="info" label={preview.first.context_provider} /></dd>
              {subjectsDaPrevia.length >= 2 ? (
                <>
                  <dt>Quem veste o quê</dt>
                  <dd>
                    <ul className="criativos-copia__lista">
                      {subjectsDaPrevia.map((s) => (
                        <li key={String(s.id)}>{String(s.persona?.label || 'Pessoa')} veste {s.product_name ? <strong>{String(s.product_name)}</strong> : 'nenhuma peça (apoio)'}</li>
                      ))}
                    </ul>
                  </dd>
                </>
              ) : (
                <><dt>Persona</dt><dd>{preview.first.persona || '—'}</dd></>
              )}
              <dt>Texto na imagem</dt><dd>{resumoOverlay(preview.first.overlay) || 'nenhum (imagem limpa)'}</dd>
              <dt>Quantidade</dt><dd>{preview.total}</dd>
            </dl>
          )}
          {preview && preview.first.warnings.length > 0 && <Callout tone="warning" title="Avisos">{preview.first.warnings.map(textoAviso).join(', ')}</Callout>}
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
