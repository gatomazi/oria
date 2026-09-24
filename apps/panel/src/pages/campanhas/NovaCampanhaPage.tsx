import { useLojaAtiva } from '../../auth/AuthContext';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, ConfirmDialog, EmptyState, Field, FormActions, Input, MediaDropzone, PageHeader, PageStack, Skeleton, StatusBadge, Stepper } from '../../components/ds';
import { adminStores } from '../../state/adminStores';
import { lookup, TEMPLATE_META_STATUS_MAP, CAMPANHA_STATUS_MAP } from '../../lib/statusMap';
import { contarVariaveis, extrairBotaoDinamico, extrairTextosComponentes, extrairTokensVariaveis } from '../../lib/templateVariables';
import { listTemplates, testarTemplate, type WhatsappTemplate } from '../../api/templates';
import { listMedia, uploadMedia, type MediaAsset } from '../../api/media';
import { criarCampanha, editarCampanha, getCampanha, iniciarCampanha, previewAudiencia, type AudienceDefinition, type AudienciaPreviewResultado } from '../../api/campanhas';
import { listSegmentos, type Segmento } from '../../api/segments';
import { AvisoSegmentoRfm } from '../clientes/AvisoSegmentoRfm';
import { AvisoCorteDaAudiencia, motivosDeExclusao } from './AudienciaResumo';
import { AudienceBuilder, audienceStateDeSalvo, audienceStateParaApi, audienceStateVazio, type AudienceState } from './AudienceBuilder';
import { PreviewMensagemWeb } from '../../components/PreviewMensagemWeb';
import { getWhatsappWebResumo, listarMensagensWeb, type MensagemWeb, type WhatsappWebResumo } from '../../api/whatsappWeb';
import { useWhatsappProvider } from '../../state/whatsappProvider';
import { plural } from '../../lib/format';

import '../../pedidos-central.css';
import '../../trocas-nova.css';
import '../../campanhas.css';

// Wizard de 5 passos (spec, Parte 4) — Campanha/Audiência/Template/Conteúdo/Revisão. No modo
// WhatsApp Web são 4: a mensagem própria já traz as variáveis nomeadas no texto (sem mapeamento
// por posição) e não tem mídia de cabeçalho, então "Conteúdo" não existe.
type EtapaChave = 'campanha' | 'audiencia' | 'template' | 'conteudo' | 'mensagem' | 'revisao';
const ETAPAS_API: { chave: EtapaChave; label: string }[] = [
  { chave: 'campanha', label: 'Campanha' },
  { chave: 'audiencia', label: 'Audiência' },
  { chave: 'template', label: 'Template' },
  { chave: 'conteudo', label: 'Conteúdo' },
  { chave: 'revisao', label: 'Revisão' },
];
const ETAPAS_WEB: { chave: EtapaChave; label: string }[] = [
  { chave: 'campanha', label: 'Campanha' },
  { chave: 'audiencia', label: 'Audiência' },
  { chave: 'mensagem', label: 'Mensagem' },
  { chave: 'revisao', label: 'Revisão' },
];

// Quantos dias a campanha leva respeitando o limite recomendado do WhatsApp Web (campanhas param
// nele). Estimativa otimista: pedidos, Pix e carrinhos do dia também consomem o mesmo limite.
function estimarDiasCampanhaWeb(destinatarios: number, resumo: WhatsappWebResumo | null): { hoje: number; dias: number } | null {
  if (!resumo?.disponivel || !resumo.limiteRecomendado) return null;
  const hoje = Math.max(0, resumo.limiteRecomendado - (resumo.enviadosHoje ?? 0));
  if (destinatarios <= hoje) return { hoje, dias: 1 };
  return { hoje, dias: (hoje > 0 ? 1 : 0) + Math.ceil((destinatarios - hoje) / resumo.limiteRecomendado) };
}

// Fontes de variável resolvíveis com segurança pelo backend hoje (dado real em
// buscarClientesAgregados) — cidade/estado/produto/cupom ficam de fora por falta de captura
// desse dado (mesma decisão da Fase 3).
const VARIAVEL_FONTES: { valor: string; label: string }[] = [
  { valor: 'cliente.primeiroNome', label: 'Primeiro nome' },
  { valor: 'cliente.nomeCompleto', label: 'Nome completo' },
  { valor: 'cliente.quantidadePedidos', label: 'Quantidade de pedidos' },
  { valor: 'cliente.totalGasto', label: 'Total gasto' },
  { valor: 'cliente.ticketMedio', label: 'Ticket médio' },
  { valor: 'cliente.ultimaCompraEm', label: 'Data da última compra' },
  { valor: 'fixo', label: 'Valor fixo' },
];

interface VariavelMapeada {
  indice: number;
  fonte: string;
  valorFixo: string;
  // "corpo" (default) usa `indice` como posição do token no BODY. "header"/"botao" existem no
  // máximo 1 por template (cabeçalho de texto com variável / botão de URL dinâmica) — `indice`
  // não é usado nesses dois casos.
  alvo: 'corpo' | 'header' | 'botao';
}

// Ordem de exibição dos grupos de template (spec do produto: campanha deve preferir MARKETING) —
// categorias fora dessa lista (ex: AUTHENTICATION) caem no fim, na ordem em que aparecerem.
const CATEGORIA_ORDEM = ['MARKETING', 'UTILITY'];
const CATEGORIA_LABEL: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utility', AUTHENTICATION: 'Autenticação' };

// `c.agendadaPara` volta em ISO (UTC) — <input type="datetime-local"> espera "YYYY-MM-DDTHH:mm"
// em horário local, senão o campo aparece vazio mesmo com a campanha já agendada.
function isoParaDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NovaCampanhaPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editarId = params.get('editar');

  const [carregandoInicial, setCarregandoInicial] = useState(!!editarId);
  const [erroInicial, setErroInicial] = useState('');
  const [step, setStep] = useState(0);
  // Campanha existente abre num resumo compilado primeiro (evita ter que passar aba a aba só
  // pra ver o que já está cadastrado) — criação do zero cai direto no wizard, não há o que
  // resumir ainda. "Editar campanha" ou clicar numa etapa específica sai desse modo.
  const [modoResumo, setModoResumo] = useState(!!editarId);
  const [campanhaId, setCampanhaId] = useState<string | null>(null);
  const [statusAtual, setStatusAtual] = useState<string>('draft');

  const [nome, setNome] = useState('');
  // Loja da Organization ativa — só exibição; o servidor decide o escopo da campanha.
  const loja = useLojaAtiva() ?? '';
  const [descricao, setDescricao] = useState('');

  const [audiencia, setAudiencia] = useState<AudienceState>(audienceStateVazio());
  const [audienciaPreview, setAudienciaPreview] = useState<AudienciaPreviewResultado | null>(null);
  // Reavaliação da audiência ao ENTRAR na revisão (e antes de enviar): a prévia da etapa Audiência é uma foto de um instante
  // anterior; a revisão mostra a contagem de agora, com o seu asOf, ou o erro verdadeiro — nunca a última resposta em silêncio.
  const [revisaoAud, setRevisaoAud] = useState<{ estado: 'carregando' } | { estado: 'ok' } | { estado: 'erro'; mensagem: string } | null>(null);
  const [avisoRevisao, setAvisoRevisao] = useState('');
  const [segmentos, setSegmentos] = useState<Segmento[] | null>(null);
  const [segmentoSelecionado, setSegmentoSelecionado] = useState('');

  const [templates, setTemplates] = useState<WhatsappTemplate[] | null>(null);
  const [templatesErro, setTemplatesErro] = useState('');
  const [templateNome, setTemplateNome] = useState<string | null>(null);
  const [templateBusca, setTemplateBusca] = useState('');

  const [variaveis, setVariaveis] = useState<VariavelMapeada[]>([]);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[] | null>(null);
  const [mediaAssetId, setMediaAssetId] = useState<number | null>(null);
  const [uploadErro, setUploadErro] = useState<string | null>(null);

  const provider = useWhatsappProvider();
  const modoWeb = provider === 'whatsapp_web';
  const etapas = modoWeb ? ETAPAS_WEB : ETAPAS_API;
  const etapaAtual = etapas[Math.min(step, etapas.length - 1)].chave;
  const indiceEtapa = (chave: EtapaChave) => Math.max(0, etapas.findIndex((e) => e.chave === chave));
  const [mensagensWeb, setMensagensWeb] = useState<MensagemWeb[] | null>(null);
  const [mensagensWebErro, setMensagensWebErro] = useState('');
  const [mensagemWebId, setMensagemWebId] = useState<string | null>(null);
  const [mensagemWebCongelada, setMensagemWebCongelada] = useState(false);
  const [resumoWeb, setResumoWeb] = useState<WhatsappWebResumo | null>(null);

  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<{ texto: string; erro: boolean } | null>(null);
  const [agendarData, setAgendarData] = useState('');
  const [tamanhoLote, setTamanhoLote] = useState('');
  const [enviarDialogAberto, setEnviarDialogAberto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [testeTelefone, setTesteTelefone] = useState('');
  const [testeEnviando, setTesteEnviando] = useState(false);
  const [testeMsg, setTesteMsg] = useState<{ texto: string; erro: boolean } | null>(null);

  // Cada modo só busca o que usa — templates da Meta falhariam no modo Web sem o serviço de
  // WhatsApp configurado.
  useEffect(() => {
    if (!provider) return;
    if (modoWeb) {
      listarMensagensWeb()
        .then((data) => setMensagensWeb(data.mensagens.filter((m) => m.tipo === 'campanha' || m.tipo === 'comum')))
        .catch((err: Error) => setMensagensWebErro(err.message));
      getWhatsappWebResumo().then(setResumoWeb).catch(() => setResumoWeb(null));
      return;
    }
    listTemplates()
      .then((data) => setTemplates(data.templates))
      .catch((err: Error) => setTemplatesErro(err.message));
  }, [provider, modoWeb]);

  // Segmentos são cross-loja (a "loja" no editor de segmento é só prévia, não é salva junto —
  // ver AudienceBuilder/SegmentosPage) — carregar 1x e deixar o wizard aplicar por cima do que
  // já estiver montado na etapa Audiência.
  useEffect(() => {
    // Recarrega quando o `?segmento=` muda (ex.: "Recriar na avaliação exata" cria um segmento NOVO e navega para ele sem remontar
    // a página): sem isto, a lista antiga não conhece o segmento novo e a tela seguiria com a audiência anterior.
    listSegmentos()
      .then((data) => setSegmentos(data.segmentos))
      .catch(() => setSegmentos([]));
  }, [params.get('segmento')]);

  // Vindo de Clientes (`?segmento=ID`): já abre com a audiência do segmento salvo aplicada.
  const segmentoDaUrl = params.get('segmento');
  useEffect(() => {
    if (!segmentoDaUrl || editarId || !segmentos) return;
    const s = segmentos.find((x) => x.id === segmentoDaUrl);
    if (!s) return;
    setSegmentoSelecionado(s.id);
    setAudiencia(audienceStateDeSalvo(s.match, s.filtros, s.exclusoes));
    setNome((atual) => atual || s.nome);
  }, [segmentoDaUrl, editarId, segmentos]);

  function aplicarSegmento(id: string) {
    setSegmentoSelecionado(id);
    if (!id) {
      // "Montar filtros manualmente" depois de um segmento RFM: a condição RFM (obrigatória) não pode ficar oculta atrás de um
      // seletor que diz "manual" — a audiência recomeça vazia. Filtros genéricos continuam ajustáveis como sempre.
      if (audiencia.rfm) setAudiencia(audienceStateVazio());
      return;
    }
    const segmento = segmentos?.find((s) => s.id === id);
    if (!segmento) return;
    setAudiencia(audienceStateDeSalvo(segmento.match, segmento.filtros, segmento.exclusoes));
  }

  useEffect(() => {
    if (!editarId) return;
    getCampanha(editarId)
      .then((data) => {
        const c = data.campanha;
        setCampanhaId(c.id);
        setStatusAtual(c.status);
        setNome(c.nome);
        setDescricao(c.descricao || '');
        setTemplateNome(c.templateNome);
        setMensagemWebId(c.mensagemWebId);
        setMensagemWebCongelada(c.mensagemWebCongelada);
        if (c.agendadaPara) setAgendarData(isoParaDatetimeLocal(c.agendadaPara));
        setTamanhoLote(c.tamanhoLote ? String(c.tamanhoLote) : '');
        const def = c.audienceDefinition as AudienceDefinition;
        if (def?.match) {
          const audState = audienceStateDeSalvo(def.match, def.filtros || [], def.exclusoes || {}, !!def.aproximadoConfirmado);
          setAudiencia(audState);
          // Recalcula a audiência de imediato (não espera o usuário visitar a etapa 2) — é o que
          // alimenta os números no resumo compilado exibido antes do wizard.
          const { match, filtros, exclusoes } = audienceStateParaApi(audState);
          previewAudiencia(match, filtros, exclusoes).then(setAudienciaPreview).catch(() => setAudienciaPreview(null));
        }
        if (def?.variaveis) setVariaveis(def.variaveis.map((v) => ({ indice: v.indice, fonte: v.fonte, valorFixo: v.variavelFixa || '', alvo: v.alvo || 'corpo' })));
        if (def?.mediaAssetId) setMediaAssetId(def.mediaAssetId);
        setCarregandoInicial(false);
      })
      .catch((err: Error) => {
        setErroInicial(err.message);
        setCarregandoInicial(false);
      });
  }, [editarId]);

  const emRevisao = modoResumo || etapaAtual === 'revisao';
  const audienciaPayload = JSON.stringify(audienceStateParaApi(audiencia));
  useEffect(() => {
    if (!emRevisao || carregandoInicial) return;
    let vigente = true;
    const { match, filtros, exclusoes } = JSON.parse(audienciaPayload) as ReturnType<typeof audienceStateParaApi>;
    setRevisaoAud({ estado: 'carregando' });
    previewAudiencia(match, filtros, exclusoes)
      .then((r) => {
        if (!vigente) return;
        setAudienciaPreview(r);
        setRevisaoAud({ estado: 'ok' });
      })
      .catch((err: Error) => {
        if (!vigente) return;
        setAudienciaPreview(null);
        setRevisaoAud({ estado: 'erro', mensagem: err.message });
      });
    return () => { vigente = false; };
  }, [emRevisao, carregandoInicial, audienciaPayload]);
  const aproximadoNaoConfirmado = !!audienciaPreview?.rfmAproximado && !audiencia.aproximadoConfirmado;
  const audienciaBloqueia = emRevisao && (revisaoAud == null || revisaoAud.estado !== 'ok' || aproximadoNaoConfirmado);

  const templateSelecionado = templates?.find((t) => t.name === templateNome) || null;
  const textosTemplate = templateSelecionado ? extrairTextosComponentes(templateSelecionado.components) : null;
  const numVariaveisCorpo = textosTemplate ? contarVariaveis(textosTemplate.corpo) : 0;
  const headerTipo = templateSelecionado?.config?.headerTipo || 'TEXT';
  const precisaMedia = headerTipo === 'IMAGE' || headerTipo === 'VIDEO' || headerTipo === 'DOCUMENT';
  const mediaDropzoneAccept = headerTipo === 'IMAGE' ? 'image' : headerTipo === 'VIDEO' ? 'video' : 'document';
  // Cabeçalho de TEXTO com variável e botão de URL dinâmica — mesmo suporte que as automações já
  // têm (carrinho/PIX), estendido pra campanha (backend: montarComponentesEnvioCampanha).
  const headerTemplateTexto = headerTipo === 'TEXT' ? textosTemplate?.header || null : null;
  const temHeaderVariavel = extrairTokensVariaveis(headerTemplateTexto).length > 0;
  const botaoDinamico = templateSelecionado ? extrairBotaoDinamico(templateSelecionado.components) : null;
  const botaoDinamicoTexto = botaoDinamico && textosTemplate ? textosTemplate.botoes[botaoDinamico.indice]?.texto || null : null;
  // Vazio = tudo de uma vez (comportamento original).
  const tamanhoLoteValor = tamanhoLote.trim() === '' ? null : Number(tamanhoLote);
  const tamanhoLoteInvalido = tamanhoLoteValor !== null && (!Number.isInteger(tamanhoLoteValor) || tamanhoLoteValor < 1);

  useEffect(() => {
    // No modo Web os templates nem são carregados — recalcular aqui zeraria o mapeamento da API já
    // salvo na campanha.
    if (modoWeb || !provider) return;
    // Garante 1 linha de mapeamento por variável do template (corpo + cabeçalho + botão), sem
    // perder o que já foi preenchido.
    setVariaveis((prev) => {
      const next: VariavelMapeada[] = [];
      for (let i = 1; i <= numVariaveisCorpo; i++) {
        next.push(
          prev.find((v) => v.alvo === 'corpo' && v.indice === i) ||
          { indice: i, alvo: 'corpo', fonte: VARIAVEL_FONTES[0].valor, valorFixo: '' }
        );
      }
      if (temHeaderVariavel) {
        next.push(prev.find((v) => v.alvo === 'header') || { indice: 0, alvo: 'header', fonte: VARIAVEL_FONTES[0].valor, valorFixo: '' });
      }
      if (botaoDinamico) {
        next.push(prev.find((v) => v.alvo === 'botao') || { indice: 0, alvo: 'botao', fonte: VARIAVEL_FONTES[0].valor, valorFixo: '' });
      }
      return next;
    });
  }, [numVariaveisCorpo, temHeaderVariavel, !!botaoDinamico, modoWeb, provider]);

  useEffect(() => {
    if (!precisaMedia) return;
    listMedia(mediaDropzoneAccept as MediaAsset['kind'])
      .then((data) => setMediaAssets(data.assets))
      .catch(() => setMediaAssets([]));
  }, [precisaMedia, mediaDropzoneAccept]);

  const mediaSelecionada = mediaAssets?.find((m) => m.id === mediaAssetId) || null;
  const podeUsarAmostra = !!templateSelecionado?.config?.sampleMediaAssetId;

  // Uma campanha só existe de fato depois do 1º save — antes disso força a ordem (garante que o
  // usuário passou pelas etapas anteriores antes de "pular" pra Conteúdo/Revisão sem dado
  // nenhum). Depois de salva pelo menos 1 vez, as abas viram atalho livre.
  const etapasClicaveis = !!campanhaId;
  const mensagemWebSelecionada = mensagensWeb?.find((m) => m.id === mensagemWebId) || null;
  const temConteudo = modoWeb ? !!mensagemWebId : !!templateNome;

  function etapaCompleta(chave: EtapaChave): boolean {
    switch (chave) {
      case 'campanha': return !!nome.trim();
      // "todos os clientes, sem filtro" também é um estado válido — mas só conta como completo
      // depois que a audiência foi de fato calculada 1x (senão fica ✓ numa campanha em branco).
      case 'audiencia': return audienciaPreview !== null;
      case 'template': return !!templateNome;
      case 'conteudo': return !!templateNome && (!precisaMedia || mediaAssetId != null) && variaveis.every((v) => !!v.fonte);
      case 'mensagem': return !!mensagemWebId;
      default: return false;
    }
  }

  function irParaEtapa(i: number) {
    setModoResumo(false);
    setStep(i);
  }

  function montarAudienceDefinition(): AudienceDefinition {
    const { match, filtros, exclusoes } = audienceStateParaApi(audiencia);
    // Modo Web guarda a escolha da mensagem e preserva o mapeamento da API já salvo (trocar de
    // modo não apaga a configuração do outro).
    return {
      match,
      filtros,
      exclusoes,
      // Só grava a confirmação quando ela foi dada (nunca `false` "por padrão").
      ...(audiencia.aproximadoConfirmado ? { aproximadoConfirmado: true } : {}),
      variaveis: variaveis.map((v) => ({ indice: v.indice, fonte: v.fonte, variavelFixa: v.fonte === 'fixo' ? v.valorFixo : undefined, alvo: v.alvo })),
      mediaAssetId: precisaMedia || modoWeb ? mediaAssetId : null,
    };
  }

  // Reavaliação IMEDIATAMENTE antes de agendar/enviar: o público pode ter mudado desde a última prévia, e uma definição que já não
  // pode ser calculada (regra RFM mudou, condição inválida, segmento aproximado sem confirmação) bloqueia com a causa. Devolve o
  // resultado ou null (e já mostra o erro).
  async function reavaliarAntesDeConfirmar(): Promise<AudienciaPreviewResultado | null> {
    const { match, filtros, exclusoes } = audienceStateParaApi(audiencia);
    try {
      const agora = await previewAudiencia(match, filtros, exclusoes);
      if (agora.rfmAproximado && !audiencia.aproximadoConfirmado) {
        const texto = `A audiência vem do segmento RFM "${agora.rfmAproximado.nome}" com avaliação aproximada: confirme o uso do público aproximado na etapa Audiência ou recrie o segmento na avaliação exata.`;
        setRevisaoAud({ estado: 'erro', mensagem: texto });
        setMsg({ texto, erro: true });
        return null;
      }
      setAvisoRevisao(audienciaPreview && agora.eligible !== audienciaPreview.eligible
        ? `A audiência foi reavaliada agora: ${plural(agora.eligible, 'destinatário elegível', 'destinatários elegíveis')} (antes ${audienciaPreview.eligible}).`
        : '');
      setAudienciaPreview(agora);
      setRevisaoAud({ estado: 'ok' });
      return agora;
    } catch (err) {
      setAudienciaPreview(null);
      setRevisaoAud({ estado: 'erro', mensagem: (err as Error).message });
      setMsg({ texto: (err as Error).message, erro: true });
      return null;
    }
  }

  async function salvar(status: 'draft' | 'scheduled') {
    if (!nome.trim()) { setMsg({ texto: 'Nome da campanha é obrigatório.', erro: true }); setStep(0); return; }
    if (status === 'scheduled' && !agendarData) { setMsg({ texto: 'Escolha data e hora do agendamento.', erro: true }); return; }
    if (tamanhoLoteInvalido) { setMsg({ texto: 'Tamanho do lote deve ser um número inteiro maior que zero.', erro: true }); return; }
    setSalvando(true);
    setMsg(null);
    if (status === 'scheduled' && !(await reavaliarAntesDeConfirmar())) { setSalvando(false); return; }
    const input = {
      nome: nome.trim(), descricao: descricao.trim() || null, templateNome, mensagemWebId,
      segmentoId: segmentoSelecionado || null,
      audienceDefinition: montarAudienceDefinition(),
      tamanhoLote: tamanhoLoteValor,
      ...(status === 'scheduled' ? { status: 'scheduled' as const, agendadaPara: new Date(agendarData).toISOString() } : {}),
    };
    const promise = campanhaId ? editarCampanha(campanhaId, input) : criarCampanha(input);
    promise
      .then((data) => {
        setCampanhaId(data.campanha.id);
        setStatusAtual(data.campanha.status);
        setMsg({ texto: status === 'scheduled' ? 'Campanha agendada!' : 'Rascunho salvo.', erro: false });
        if (status === 'scheduled') setTimeout(() => navigate('/admin/campanhas'), 1200);
      })
      .catch((err: Error) => setMsg({ texto: err.message, erro: true }))
      .finally(() => setSalvando(false));
  }

  // Salva (rascunho) e só então abre a confirmação — precisa do id da campanha real (o /start
  // roda o snapshot de destinatários no backend, não pode iniciar em cima de dados não salvos).
  async function prepararEnvioAgora() {
    if (!nome.trim()) { setMsg({ texto: 'Nome da campanha é obrigatório.', erro: true }); setStep(0); return; }
    if (!temConteudo) {
      setMsg({ texto: modoWeb ? 'Escolha uma mensagem antes de enviar.' : 'Escolha um template antes de enviar.', erro: true });
      setStep(indiceEtapa(modoWeb ? 'mensagem' : 'template'));
      return;
    }
    if (tamanhoLoteInvalido) { setMsg({ texto: 'Tamanho do lote deve ser um número inteiro maior que zero.', erro: true }); return; }
    setSalvando(true);
    setMsg(null);
    try {
      const input = {
        nome: nome.trim(), descricao: descricao.trim() || null, templateNome, mensagemWebId,
        segmentoId: segmentoSelecionado || null,
        audienceDefinition: montarAudienceDefinition(), tamanhoLote: tamanhoLoteValor,
      };
      const data = campanhaId ? await editarCampanha(campanhaId, input) : await criarCampanha(input);
      setCampanhaId(data.campanha.id);
      setStatusAtual(data.campanha.status);
      // Última reavaliação ANTES de pedir a confirmação: se não for possível calcular (ex.: regra RFM mudou), não abre a confirmação.
      if (!(await reavaliarAntesDeConfirmar())) return;
      setEnviarDialogAberto(true);
    } catch (err) {
      setMsg({ texto: (err as Error).message, erro: true });
      setRevisaoAud({ estado: 'erro', mensagem: (err as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  // Devolve a Promise pro ConfirmDialog aguardar — antes era fire-and-forget e o dialog fechava
  // na hora do clique, deixando a página parada sem nenhum indicador enquanto a request de
  // verdade ainda rodava (parecia travado). Rejeita de novo depois de mostrar o erro, pra o
  // dialog saber que falhou e continuar aberto em vez de fechar como se tivesse dado certo.
  function confirmarEnvioAgora() {
    if (!campanhaId) return Promise.resolve();
    setEnviando(true);
    setMsg(null);
    return iniciarCampanha(campanhaId)
      .then(() => {
        setMsg({ texto: 'Campanha iniciada — o envio real acontece em segundo plano.', erro: false });
        // Vai direto pro relatório: é lá que se acompanha o lote e libera o próximo.
        setTimeout(() => navigate(`/admin/campanhas/${campanhaId}`), 1200);
      })
      .catch((err: Error) => {
        setMsg({ texto: err.message, erro: true });
        throw err;
      })
      .finally(() => setEnviando(false));
  }

  function enviarTeste() {
    if (!templateSelecionado || !textosTemplate) return;
    if (!testeTelefone.trim()) { setTesteMsg({ texto: 'Informe um telefone de teste.', erro: true }); return; }
    setTesteEnviando(true);
    setTesteMsg(null);
    // Mesmo serviço/endpoint já usado pra testar template avulso (spec, Parte 15: "usar
    // exatamente o mesmo serviço... não criar uma implementação separada e divergente") —
    // valores de exemplo aqui, a resolução por destinatário real só existe a partir da Fase 5.
    const valorDe = (v: VariavelMapeada) => (v.fonte === 'fixo' ? v.valorFixo || 'Exemplo' : 'Exemplo');
    testarTemplate(templateSelecionado.name, {
      telefone: testeTelefone.trim(),
      valores: {
        corpo: variaveis.filter((v) => v.alvo === 'corpo').map(valorDe),
        header: temHeaderVariavel ? valorDe(variaveis.find((v) => v.alvo === 'header') || { fonte: '', valorFixo: '' } as VariavelMapeada) : undefined,
        botao: botaoDinamico ? valorDe(variaveis.find((v) => v.alvo === 'botao') || { fonte: '', valorFixo: '' } as VariavelMapeada) : undefined,
      },
    })
      .then(() => setTesteMsg({ texto: 'Teste enviado!', erro: false }))
      .catch((err: Error) => setTesteMsg({ texto: err.message, erro: true }))
      .finally(() => setTesteEnviando(false));
  }

  if (carregandoInicial || !provider) return <Skeleton rows={6} />;
  if (erroInicial) return <EmptyState title="Não foi possível carregar a campanha" description={erroInicial} />;

  const podeEditar = statusAtual === 'draft' || statusAtual === 'scheduled';
  const estimativaWeb = modoWeb && audienciaPreview ? estimarDiasCampanhaWeb(audienciaPreview.eligible, resumoWeb) : null;

  function textoAudiencia(forma: 'resumo' | 'revisao'): string {
    if (revisaoAud?.estado === 'erro') return 'Não foi possível calcular a audiência';
    if (!audienciaPreview || revisaoAud?.estado === 'carregando') return 'Calculando…';
    const base = audienciaPreview.rfm ? 'no segmento' : 'encontrados';
    return forma === 'resumo'
      ? `${audienciaPreview.eligible} elegíveis (${audienciaPreview.matched} ${base}, ${audienciaPreview.excluded} excluídos)`
      : `${audienciaPreview.matched} ${base}, ${audienciaPreview.excluded} excluídos, ${audienciaPreview.eligible} elegíveis`;
  }

  // Detalhe da audiência na revisão: erro verdadeiro, motivos de exclusão e, no segmento RFM, universos, asOf, regra e corte.
  const detalheAudiencia = (
    <>
      {revisaoAud?.estado === 'erro' && (
        <div role="alert" className="ds-form-error">{revisaoAud.mensagem} O envio fica bloqueado até a audiência poder ser calculada.</div>
      )}
      {audienciaPreview && revisaoAud?.estado === 'ok' && (
        <>
          {motivosDeExclusao(audienciaPreview.breakdown).length > 0 && (
            <p className="pc-nota ad-preview-linha">Excluídos por contato: {motivosDeExclusao(audienciaPreview.breakdown).map((m) => `${m.n} ${m.rotulo}`).join(' · ')}.</p>
          )}
          {audienciaPreview.rfm && (
            <p className="pc-nota ad-preview-linha">
              Segmento RFM {audienciaPreview.rfm.segmentoNome}: {plural(audienciaPreview.rfm.universos.segmento, 'pessoa', 'pessoas')} de {plural(audienciaPreview.rfm.universos.compradoresValidos, 'comprador válido', 'compradores válidos')} ·
              calculado agora, regra {audienciaPreview.rfm.regraVersao}.
            </p>
          )}
          <AvisoCorteDaAudiencia preview={audienciaPreview} />
        </>
      )}
      {avisoRevisao && <p className="ds-form-note" role="status">{avisoRevisao}</p>}
    </>
  );

  return (
    <PageStack>
      <PageHeader title={campanhaId ? `Editar campanha` : 'Nova campanha'} back={{ to: '/admin/campanhas', label: 'Voltar pra campanhas' }} />

      {!podeEditar && (
        <p className="ds-form-error">Esta campanha já foi iniciada e não pode mais ser editada por aqui.</p>
      )}

      {modoResumo && (
        <Card>
          <div className="ad-revisao">
            <div><span className="pc-nota">Campanha</span><strong>{nome || '—'}</strong></div>
            <div><span className="pc-nota">Loja</span><strong>{adminStores.name(loja)}</strong></div>
            <div><span className="pc-nota">Status</span><strong>{lookup(CAMPANHA_STATUS_MAP, statusAtual).label}</strong></div>
            <div>
              <span className="pc-nota">Audiência</span>
              <strong>
                {textoAudiencia('resumo')}
              </strong>
            </div>
            {modoWeb ? (
              <div><span className="pc-nota">Mensagem</span><strong>{mensagemWebSelecionada?.nome || 'Nenhuma escolhida'}</strong></div>
            ) : (
              <div><span className="pc-nota">Template</span><strong>{templateNome || 'Nenhum escolhido'}</strong></div>
            )}
            {!modoWeb && precisaMedia && <div><span className="pc-nota">Mídia</span><strong>{mediaSelecionada?.filename || 'nenhuma selecionada'}</strong></div>}
            {!modoWeb && variaveis.length > 0 && (
              <div>
                <span className="pc-nota">Variáveis</span>
                <strong>
                  {variaveis.map((v) => {
                    const rotulo = v.alvo === 'header' ? 'Cabeçalho' : v.alvo === 'botao' ? 'Botão' : `{{${v.indice}}}`;
                    return `${rotulo} → ${VARIAVEL_FONTES.find((f) => f.valor === v.fonte)?.label || v.fonte}`;
                  }).join(' · ')}
                </strong>
              </div>
            )}
            <div>
              <span className="pc-nota">Agendamento</span>
              <strong>{agendarData ? new Date(agendarData).toLocaleString('pt-BR') : 'Sem agendamento (enviar agora)'}</strong>
            </div>
            <div>
              <span className="pc-nota">Envio</span>
              <strong>{tamanhoLoteValor && !tamanhoLoteInvalido ? `Em lotes de ${tamanhoLoteValor}` : 'Tudo de uma vez'}</strong>
            </div>
          </div>
          {detalheAudiencia}

          <div className="ds-button-row">
            <Button onClick={() => irParaEtapa(0)}>Editar campanha</Button>
            {etapas.map((etapa, i) => (
              <Button key={etapa.chave} variant="secondary" onClick={() => irParaEtapa(i)}>
                {etapa.label}
              </Button>
            ))}
          </div>
        </Card>
      )}

      {!modoResumo && (
      <>
      <Stepper
        steps={etapas.map((e) => e.label)}
        current={step}
        isCompleted={(i) => etapaCompleta(etapas[i].chave)}
        onSelect={setStep}
        canSelect={etapasClicaveis}
        disabledHint="Salve a campanha (rascunho) pra poder pular direto pra qualquer etapa"
        label="Etapas da campanha"
      />

      <Card>
        {etapaAtual === 'campanha' && (
          <div className="tn-form">
            <Field label="Nome da campanha">
              <Input type="text" placeholder="ex: Reativação clientes 90 dias" value={nome} onChange={(e) => setNome(e.target.value)} disabled={!podeEditar} />
            </Field>
            <Field label="Descrição interna (opcional)">
              <textarea className="ds-textarea" value={descricao} onChange={(e) => setDescricao(e.target.value)} disabled={!podeEditar} />
            </Field>
          </div>
        )}

        {etapaAtual === 'audiencia' && (
          <div className="tn-form">
            {segmentos != null && segmentos.length > 0 && (
              <Field label="Usar segmento salvo (opcional)" hint="Aplica os filtros e exclusões do segmento aqui — dá pra ajustar depois de carregar.">
                <select className="ds-select" value={segmentoSelecionado} onChange={(e) => aplicarSegmento(e.target.value)} disabled={!podeEditar}>
                  <option value="">Montar filtros manualmente</option>
                  {segmentos.map((s) => (
                    <option key={s.id} value={s.id}>{s.nome}</option>
                  ))}
                </select>
              </Field>
            )}
            {segmentoSelecionado && segmentos?.find((sg) => sg.id === segmentoSelecionado)?.origem === 'rfm' && (
              <AvisoSegmentoRfm segmentoId={segmentoSelecionado} />
            )}
            <AudienceBuilder loja={loja} state={audiencia} onChange={setAudiencia} onPreview={setAudienciaPreview} />
          </div>
        )}

        {etapaAtual === 'mensagem' && (
          <div className="tn-form">
            {mensagemWebCongelada && (
              <p className="pc-nota">O texto desta campanha já foi congelado quando ela começou — trocar ou editar a mensagem não muda o que está sendo enviado.</p>
            )}
            {mensagensWebErro && <p className="ds-form-error">{mensagensWebErro}</p>}
            {!mensagensWeb && !mensagensWebErro && <Skeleton rows={3} />}
            {mensagensWeb && mensagensWeb.length === 0 && (
              <EmptyState
                title="Nenhuma mensagem de campanha ainda"
                description='Crie uma mensagem do tipo "Campanha" (ou "Comum") em Mensagens.'
                action={<Link to="/admin/mensagens/nova" className="ds-btn ds-btn--primary">Nova mensagem</Link>}
              />
            )}
            {mensagensWeb && mensagensWeb.length > 0 && (
              <div className="ad-template-lista">
                {mensagensWeb.map((m) => (
                  <label key={m.id} className={'ad-template-opcao' + (mensagemWebId === m.id ? ' ad-template-opcao--ativa' : '')}>
                    <input type="radio" name="mensagemWeb" checked={mensagemWebId === m.id} onChange={() => setMensagemWebId(m.id)} disabled={!podeEditar} />
                    <div>
                      <strong>{m.nome}</strong>
                      <span className="pc-nota">
                        {m.tipo === 'campanha' ? 'Campanha' : 'Comum'}
                        {m.variacoes?.length ? ` · ${m.variacoes.length + 1} versões` : ' · 1 versão'}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            )}
            {mensagemWebSelecionada && (
              <>
                <PreviewMensagemWeb
                  corpo={mensagemWebSelecionada.corpo}
                  dica={
                    mensagemWebSelecionada.variacoes?.length
                      ? `Prévia da versão 1 de ${mensagemWebSelecionada.variacoes.length + 1} — cada cliente recebe uma versão sorteada, com os próprios dados.`
                      : 'Prévia com dados de exemplo — cada cliente recebe com os próprios dados.'
                  }
                />
                {!mensagemWebSelecionada.variacoes?.length && (
                  <p className="pc-nota">Dica: adicione mais versões do texto na mensagem pra cada cliente receber uma diferente — reduz o risco de bloqueio em campanhas.</p>
                )}
                <Link className="ds-btn ds-btn--ghost" to={`/admin/mensagens/${mensagemWebSelecionada.id}`}>
                  Editar texto da mensagem
                </Link>
              </>
            )}
          </div>
        )}

        {etapaAtual === 'template' && (
          <div className="tn-form">
            {templatesErro && <p className="ds-form-error">{templatesErro}</p>}
            {!templates && !templatesErro && <Skeleton rows={3} />}
            {templates && (() => {
              const aprovados = templates.filter((t) => t.status === 'APPROVED');
              const busca = templateBusca.trim().toLowerCase();
              const filtrados = busca ? aprovados.filter((t) => t.name.toLowerCase().includes(busca)) : aprovados;
              const categorias = Array.from(new Set(filtrados.map((t) => t.category || 'OUTROS'))).sort((a, b) => {
                const ia = CATEGORIA_ORDEM.indexOf(a); const ib = CATEGORIA_ORDEM.indexOf(b);
                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
              });
              return (
                <>
                  {aprovados.length > 0 && (
                    <Input
                      type="text"
                      placeholder="Buscar template por nome…"
                      value={templateBusca}
                      onChange={(e) => setTemplateBusca(e.target.value)}
                    />
                  )}
                  {aprovados.length === 0 && (
                    <EmptyState title="Nenhum template aprovado ainda" description="Só templates aprovados pela Meta podem ser usados numa campanha." />
                  )}
                  {aprovados.length > 0 && filtrados.length === 0 && (
                    <p className="pc-nota">Nenhum template aprovado bate com "{templateBusca}".</p>
                  )}
                  {categorias.map((categoria) => (
                    <div key={categoria}>
                      <div className="ad-template-grupo-titulo">{CATEGORIA_LABEL[categoria] || categoria}</div>
                      <div className="ad-template-lista">
                        {filtrados.filter((t) => (t.category || 'OUTROS') === categoria).map((t) => (
                          <label key={t.name} className={'ad-template-opcao' + (templateNome === t.name ? ' ad-template-opcao--ativa' : '')}>
                            <input type="radio" name="template" checked={templateNome === t.name} onChange={() => setTemplateNome(t.name)} disabled={!podeEditar} />
                            <div>
                              <strong>{t.name}</strong>
                              <span className="pc-nota">
                                {t.language} · {t.config?.headerTipo && t.config.headerTipo !== 'TEXT' ? t.config.headerTipo : 'sem mídia'}
                              </span>
                            </div>
                            <StatusBadge tone={lookup(TEMPLATE_META_STATUS_MAP, t.status).tone} label={lookup(TEMPLATE_META_STATUS_MAP, t.status).label} />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        )}

        {etapaAtual === 'conteudo' && (
          <div className="tn-form">
            {!templateSelecionado && <EmptyState title="Escolha um template na etapa anterior primeiro" />}
            {templateSelecionado && (
              <>
                {precisaMedia && (
                  <Field label="Mídia do cabeçalho">
                    {podeUsarAmostra && mediaAssetId == null && (
                      <Button variant="secondary" onClick={() => setMediaAssetId(templateSelecionado.config!.sampleMediaAssetId!)}>
                        Usar a mesma mídia da amostra
                      </Button>
                    )}
                    <MediaDropzone
                      accept={mediaDropzoneAccept as 'image' | 'video' | 'document'}
                      erro={uploadErro}
                      value={mediaSelecionada ? { filename: mediaSelecionada.filename, sizeBytes: mediaSelecionada.sizeBytes, previewUrl: mediaSelecionada.previewUrl } : null}
                      onUpload={async (file) => {
                        setUploadErro(null);
                        const resultado = await uploadMedia(file);
                        if (resultado.avisoMeta) setUploadErro(resultado.avisoMeta);
                        setMediaAssetId(resultado.asset.id);
                        setMediaAssets((prev) => [resultado.asset, ...(prev || [])]);
                      }}
                      onRemove={() => setMediaAssetId(null)}
                    />
                  </Field>
                )}

                {temHeaderVariavel && (() => {
                  const v = variaveis.find((p) => p.alvo === 'header');
                  return (
                    <Field label="Variável do cabeçalho" hint="Texto do cabeçalho aprovado — mostrado aqui só de referência.">
                      {headerTemplateTexto && (
                        <p className="pc-nota ad-template-preview-corpo">
                          {headerTemplateTexto.split(/(\{\{[^{}]+\}\})/g).map((parte, i) =>
                            /^\{\{[^{}]+\}\}$/.test(parte) ? <strong key={i}>{parte}</strong> : <span key={i}>{parte}</span>
                          )}
                        </p>
                      )}
                      {v && (
                        <div className="ad-filtro-row">
                          <select
                            className="ds-select"
                            value={v.fonte}
                            onChange={(e) => setVariaveis((prev) => prev.map((p) => (p.alvo === 'header' ? { ...p, fonte: e.target.value } : p)))}
                          >
                            {VARIAVEL_FONTES.map((f) => (
                              <option key={f.valor} value={f.valor}>{f.label}</option>
                            ))}
                          </select>
                          {v.fonte === 'fixo' && (
                            <Input
                              type="text"
                              placeholder="valor fixo"
                              value={v.valorFixo}
                              onChange={(e) => setVariaveis((prev) => prev.map((p) => (p.alvo === 'header' ? { ...p, valorFixo: e.target.value } : p)))}
                            />
                          )}
                        </div>
                      )}
                    </Field>
                  );
                })()}

                {numVariaveisCorpo > 0 && (
                  <Field label="Variáveis do corpo da mensagem" hint="É o texto real do template escolhido na etapa anterior — mostrado aqui só de referência, não é editável.">
                    {textosTemplate?.corpo && (
                      <p className="pc-nota ad-template-preview-corpo">
                        {textosTemplate.corpo.split(/(\{\{[^{}]+\}\})/g).map((parte, i) =>
                          /^\{\{[^{}]+\}\}$/.test(parte) ? <strong key={i}>{parte}</strong> : <span key={i}>{parte}</span>
                        )}
                      </p>
                    )}
                    <div className="ad-variaveis-lista">
                      {variaveis.filter((v) => v.alvo === 'corpo').map((v) => (
                        <div key={v.indice} className="ad-filtro-row">
                          <span>{'{{' + v.indice + '}}'}</span>
                          <select
                            className="ds-select"
                            value={v.fonte}
                            onChange={(e) => setVariaveis((prev) => prev.map((p) => (p.alvo === 'corpo' && p.indice === v.indice ? { ...p, fonte: e.target.value } : p)))}
                          >
                            {VARIAVEL_FONTES.map((f) => (
                              <option key={f.valor} value={f.valor}>{f.label}</option>
                            ))}
                          </select>
                          {v.fonte === 'fixo' && (
                            <Input
                              type="text"
                              placeholder="valor fixo"
                              value={v.valorFixo}
                              onChange={(e) => setVariaveis((prev) => prev.map((p) => (p.alvo === 'corpo' && p.indice === v.indice ? { ...p, valorFixo: e.target.value } : p)))}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </Field>
                )}

                {botaoDinamico && (() => {
                  const v = variaveis.find((p) => p.alvo === 'botao');
                  return (
                    <Field label={`Variável do botão${botaoDinamicoTexto ? ` "${botaoDinamicoTexto}"` : ''}`} hint="Preenche a parte dinâmica do link do botão de URL.">
                      {v && (
                        <div className="ad-filtro-row">
                          <select
                            className="ds-select"
                            value={v.fonte}
                            onChange={(e) => setVariaveis((prev) => prev.map((p) => (p.alvo === 'botao' ? { ...p, fonte: e.target.value } : p)))}
                          >
                            {VARIAVEL_FONTES.map((f) => (
                              <option key={f.valor} value={f.valor}>{f.label}</option>
                            ))}
                          </select>
                          {v.fonte === 'fixo' && (
                            <Input
                              type="text"
                              placeholder="valor fixo"
                              value={v.valorFixo}
                              onChange={(e) => setVariaveis((prev) => prev.map((p) => (p.alvo === 'botao' ? { ...p, valorFixo: e.target.value } : p)))}
                            />
                          )}
                        </div>
                      )}
                    </Field>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {etapaAtual === 'revisao' && (
          <div className="tn-form">
            <div className="ad-revisao">
              <div><span className="pc-nota">Campanha</span><strong>{nome || '—'}</strong></div>
              <div><span className="pc-nota">Loja</span><strong>{adminStores.name(loja)}</strong></div>
              <div>
                <span className="pc-nota">Audiência</span>
                <strong>
                  {textoAudiencia('revisao')}
                </strong>
              </div>
              {modoWeb ? (
                <div><span className="pc-nota">Mensagem</span><strong>{mensagemWebSelecionada?.nome || '—'}</strong></div>
              ) : (
                <>
                  <div><span className="pc-nota">Template</span><strong>{templateNome || '—'}</strong></div>
                  <div><span className="pc-nota">Cabeçalho</span><strong>{headerTipo}</strong></div>
                </>
              )}
              {!modoWeb && precisaMedia && <div><span className="pc-nota">Mídia</span><strong>{mediaSelecionada?.filename || 'nenhuma selecionada'}</strong></div>}
            </div>
            {detalheAudiencia}

            {modoWeb && estimativaWeb && audienciaPreview && (
              <p className={estimativaWeb.dias > 1 ? 'wa-alerta' : 'pc-nota'}>
                {estimativaWeb.dias > 1 ? (
                  <>
                    <strong>O envio vai levar pelo menos {estimativaWeb.dias} dias.</strong> Campanhas pelo WhatsApp Web param no limite recomendado de{' '}
                    {resumoWeb?.limiteRecomendado} mensagens por dia (hoje ainda cabem {estimativaWeb.hoje}), pra reduzir o risco de bloqueio do número. O
                    restante continua na fila e sai nos dias seguintes.
                  </>
                ) : (
                  <>
                    {audienciaPreview.eligible === 1 ? 'O destinatário cabe' : `Os ${audienciaPreview.eligible} destinatários cabem`} no limite recomendado de hoje ({estimativaWeb.hoje} {estimativaWeb.hoje === 1 ? 'restante' : 'restantes'} de{' '}
                    {resumoWeb?.limiteRecomendado}).
                  </>
                )}
              </p>
            )}

            {!modoWeb && (
            <Field label="Enviar teste pra um número antes de agendar (opcional)">
              <div className="ds-button-row">
                <Input type="text" placeholder="(11) 91234-5678" value={testeTelefone} onChange={(e) => setTesteTelefone(e.target.value)} />
                <Button variant="secondary" disabled={testeEnviando || !templateSelecionado} onClick={enviarTeste}>
                  {testeEnviando ? 'Enviando…' : 'Enviar teste'}
                </Button>
              </div>
              {testeMsg && <div className={testeMsg.erro ? 'ds-form-error' : 'ds-form-note'}>{testeMsg.texto}</div>}
            </Field>
            )}

            <Field label="Agendamento (opcional)" hint="Deixe em branco e use “Enviar agora” pra disparar assim que confirmar.">
              <Input type="datetime-local" value={agendarData} onChange={(e) => setAgendarData(e.target.value)} disabled={!podeEditar} />
            </Field>

            <Field
              label="Enviar em lotes (opcional)"
              hint="Quantos destinatários no 1º lote. O restante fica guardado aguardando você liberar o próximo lote na tela da campanha — ninguém recebe duas vezes. Em branco = todos de uma vez."
            >
              <Input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder="Todos de uma vez"
                value={tamanhoLote}
                onChange={(e) => setTamanhoLote(e.target.value)}
                disabled={!podeEditar}
              />
              {tamanhoLoteInvalido && <div className="ds-form-error">Use um número inteiro maior que zero.</div>}
            </Field>

            <div className="ds-button-row">
              <Button variant="secondary" disabled={salvando || enviando || !podeEditar} onClick={() => salvar('draft')}>
                {salvando ? 'Salvando…' : 'Salvar rascunho'}
              </Button>
              <Button variant="secondary" disabled={salvando || enviando || !podeEditar || !agendarData || audienciaBloqueia} onClick={() => salvar('scheduled')}>
                Agendar campanha
              </Button>
              <Button
                variant="danger"
                disabled={salvando || enviando || !podeEditar || !!agendarData || !temConteudo || audienciaBloqueia}
                onClick={prepararEnvioAgora}
              >
                {salvando ? 'Salvando…' : 'Enviar agora'}
              </Button>
            </div>
            {msg && <div className={msg.erro ? 'ds-form-error' : 'ds-form-note'}>{msg.texto}</div>}
          </div>
        )}
      </Card>

      <FormActions
        start={
          <Button variant="secondary" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Voltar
          </Button>
        }
      >
        {step < etapas.length - 1 && <Button onClick={() => setStep((s) => s + 1)}>Avançar</Button>}
      </FormActions>
      </>
      )}

      <ConfirmDialog
        open={enviarDialogAberto}
        onClose={() => setEnviarDialogAberto(false)}
        title="Enviar campanha agora?"
        description={
          <>
            {modoWeb && 'As mensagens entram na fila do WhatsApp Web e saem respeitando o limite diário. '}
            {tamanhoLoteValor && !tamanhoLoteInvalido ? (
              <>
                Isso enviará mensagens reais de WhatsApp para o 1º lote:{' '}
                <strong>
                  {audienciaPreview
                    ? `${Math.min(tamanhoLoteValor, audienciaPreview.eligible)} de ${plural(audienciaPreview.eligible, 'destinatário', 'destinatários')}`
                    : plural(tamanhoLoteValor, 'destinatário', 'destinatários')}
                </strong>
                . O restante fica aguardando você liberar o próximo lote na tela da campanha.
              </>
            ) : (
              <>
                Isso enviará mensagens reais de WhatsApp para{' '}
                <strong>{audienciaPreview ? plural(audienciaPreview.eligible, 'destinatário', 'destinatários') : 'os destinatários elegíveis'}</strong>.
              </>
            )}
            {' '}Essa ação não pode ser desfeita.
          </>
        }
        confirmLabel={enviando ? 'Enviando…' : 'Enviar agora'}
        confirmVariant="danger"
        onConfirm={confirmarEnvioAgora}
      />
    </PageStack>
  );
}
