import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, Card, ConfirmDialog, Disclosure, EmptyState, ErrorState, Field, FormActions, FormGrid, InfoTooltip, Input, PageHeader, RadioCardGroup, Skeleton, StatusBadge } from '../../components/ds';
import { PreviewWhatsapp } from '../../components/template-editor';
import { PreviewMensagemWeb } from '../../components/PreviewMensagemWeb';
import { listarMensagensWeb, salvarVinculoWeb, type MensagemWeb } from '../../api/whatsappWeb';
import { definirCamposCustomizados, extrairTextosComponentes } from '../../lib/templateVariables';
import { eventoLabel } from '../../lib/eventLabels';
import { useLojaAtiva } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import {
  getAutomacaoEventos,
  getAutomationSettings,
  getCamposCustomizadosRefs,
  getWebhookLogAutomacoes,
  getWhatsappTemplates,
  removerAutomacaoEvento as removerVinculo,
  salvarAutomacaoEvento as salvarVinculo,
  updateAutomationSettings,
  type AutomationSettings,
  type AutomacaoEventosPorLoja as EventosConfigPorLoja,
  type AutomacaoEventoConfig as VinculoConfig,
  type WhatsappTemplateResumo as WhatsappTemplate,
} from '../../api/automacoes';
import type { WebhookEvento } from '../../api/eventos';

import '../../../../src/pedidos-central.css';
import '../../../../src/templates.css';
import '../../../../src/automacoes.css';

// Porte de src/automacoes.js (Fase 3, docs/plan.md) — a mais complexa deste lote por depender
// do template-editor (Fase 4) inteiro.

// Mesma heurística usada em Eventos e no servidor — sem lista fixa de nomes de evento vindo da
// Reserva Ink, classifica por palavra-chave até termos confirmação de todo o catálogo real.
function eventoEhDeCarrinho(nome: string): boolean {
  const n = nome.toLowerCase();
  return n.includes('cart') || n.includes('carrinho');
}

const EVENTO_PIX_PENDENTE = 'pix.pendente';
function eventoTemCadencia(nome: string): boolean {
  return eventoEhDeCarrinho(nome) || nome === EVENTO_PIX_PENDENTE;
}

type NumberFieldProps = { value: number; onChange: (v: number) => void; min?: number; max?: number; label?: string; id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };

function NumberFieldBase({ value, onChange, min, max, label, ...rest }: NumberFieldProps) {
  return <Input type="number" aria-label={label} min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} {...rest} />;
}
// dsControl: o Field associa o rótulo (id/aria-describedby) como faz com Input/Select.
const NumberField = Object.assign(NumberFieldBase, { dsControl: true });

function EnvioSwitch({ dados, recarregar }: { dados: AutomationSettings; recarregar: () => void }) {
  const [inicio, setInicio] = useState(dados.janelaEnvio?.inicio ?? 8);
  const [fim, setFim] = useState(dados.janelaEnvio?.fim ?? 22);
  const [msgJanela, setMsgJanela] = useState<{ tipo: 'nota' | 'erro'; texto: string } | null>(null);
  const [modoErro, setModoErro] = useState('');

  function trocarModo(modo: string) {
    setModoErro('');
    updateAutomationSettings({ modoEnvio: modo })
      .then(recarregar)
      .catch((err: Error) => setModoErro(err.message));
  }

  function salvarJanela() {
    setMsgJanela(null);
    if (!Number.isInteger(inicio) || !Number.isInteger(fim) || inicio >= fim) {
      setMsgJanela({ tipo: 'erro', texto: 'início deve ser menor que fim' });
      return;
    }
    updateAutomationSettings({ janelaEnvio: { inicio, fim } })
      .then(() => setMsgJanela({ tipo: 'nota', texto: 'salvo!' }))
      .catch((err: Error) => setMsgJanela({ tipo: 'erro', texto: err.message }));
  }

  return (
    <Card title="Envio automático">
      <div className="ds-stack">
      {!dados.whatsappConfigurado && dados.provider !== 'whatsapp_web' && (
        <Callout tone="danger" title="Envio de WhatsApp não configurado">
          O envio (manual ou automático) não vai funcionar até o serviço de WhatsApp ser configurado no servidor.
          <Disclosure summary="Detalhes técnicos">
            Variáveis de ambiente <code>WHATSAPP_SERVICE_URL</code> e <code>WHATSAPP_API_KEY</code> ausentes (configuração no Railway).
          </Disclosure>
        </Callout>
      )}
      {dados.provider === 'whatsapp_web' ? (
        <p className="pc-nota">
          Envio pelo <strong>WhatsApp Web</strong> (ver Integrações). Eventos vinculados a um template (abaixo) entram na{' '}
          <Link to="/admin/whatsapp/fila">fila de envio</Link> quando o webhook da Reserva Ink chegar. "Manual" deixa a mensagem aguardando
          aprovação na fila. "Automático" libera direto para o agente, que envia respeitando o volume diário recomendado.
        </p>
      ) : (
        <p className="pc-nota">
          Eventos vinculados a um template (abaixo) disparam quando o webhook da Reserva Ink chegar. "Manual" só coloca a mensagem na fila do
          WhatsApp — alguém revisa e clica enviar no dashboard do serviço de WhatsApp. "Automático" manda direto, sem revisão nenhuma.
        </p>
      )}
      <RadioCardGroup<'manual' | 'automatico'>
        name="modoEnvio"
        legend="Modo de envio"
        hideLegend
        value={dados.modoEnvio as 'manual' | 'automatico'}
        onChange={(v) => trocarModo(v)}
        options={[
          { value: 'manual', title: 'Manual (fila com revisão)' },
          { value: 'automatico', title: 'Automático (envio direto)' },
        ]}
      />
      {modoErro && <p className="ds-form-error">{modoErro}</p>}
      <Field label="Janela de horário de envio (exceto pagamento aprovado)">
        <div className="ad-janela-envio">
          <NumberField label="Hora de início" value={inicio} onChange={setInicio} min={0} max={23} />
          <span>h até</span>
          <NumberField label="Hora de fim" value={fim} onChange={setFim} min={1} max={24} />
          <span>h</span>
          <Button variant="ghost" onClick={salvarJanela}>
            Salvar janela
          </Button>
          {msgJanela && <span className={msgJanela.tipo === 'erro' ? 'ds-form-error' : 'ds-form-note'}>{msgJanela.texto}</span>}
        </div>
      </Field>
      </div>
    </Card>
  );
}

// Cadência de reenvio (carrinho abandonado e Pix pendente) — é do evento, vale igual pro vínculo
// da API e do WhatsApp Web.
interface Cadencia {
  atraso: number;
  maxEnvios: number;
  intervalo: number;
  checarCompra: boolean;
}

function cadenciaInicial(eventName: string, config: VinculoConfig | null): Cadencia {
  return {
    atraso: config?.atrasoPrimeiroEnvioHoras ?? (eventName === EVENTO_PIX_PENDENTE ? 4 : 24),
    maxEnvios: config?.maxEnvios || 1,
    intervalo: config?.intervaloHoras || 24,
    checarCompra: config ? config.checarCompra !== false : true,
  };
}

function cadenciaParaBody(c: Cadencia): Record<string, unknown> {
  return { atrasoPrimeiroEnvioHoras: c.atraso || 0, maxEnvios: c.maxEnvios || 1, intervaloHoras: c.intervalo || 24, checarCompra: c.checarCompra };
}

function CadenciaCampos({ valor, onChange }: { valor: Cadencia; onChange: (c: Cadencia) => void }) {
  return (
    <div className="ad-vinculo-carrinho">
      <p className="pc-nota">Reenvia até o limite abaixo, respeitando o intervalo, e para de reenviar se o cliente já comprou (ou já pagou o Pix).</p>
      <FormGrid min={180}>
        <Field label="Espera antes do 1º envio" hint="Em horas.">
          <NumberField value={valor.atraso} onChange={(v) => onChange({ ...valor, atraso: v })} min={0} max={720} />
        </Field>
        <Field label="Quantas vezes enviar" hint="1 = só a mensagem inicial, sem reenvio.">
          <NumberField value={valor.maxEnvios} onChange={(v) => onChange({ ...valor, maxEnvios: v })} min={1} max={10} />
        </Field>
        <Field label="Intervalo entre envios" hint="Em horas.">
          <NumberField value={valor.intervalo} onChange={(v) => onChange({ ...valor, intervalo: v })} min={1} max={720} />
        </Field>
      </FormGrid>
      <label className="ad-vinculo-checar">
        <input type="checkbox" checked={valor.checarCompra} onChange={(e) => onChange({ ...valor, checarCompra: e.target.checked })} />
        {' '}Não reenviar se o cliente já comprou desde o último envio
      </label>
    </div>
  );
}

// Vínculo evento→template de uma loja. `abrirDeInicio` inicia o form expandido — usado quando o
// admin acabou de adicionar esse evento manualmente (ainda não existe no backend).
function VinculoCard({
  loja,
  eventName,
  templates,
  configExistente,
  recarregar,
  abrirDeInicio,
}: {
  loja: string;
  eventName: string;
  templates: WhatsappTemplate[];
  configExistente: VinculoConfig | null;
  recarregar: () => void;
  abrirDeInicio: boolean;
}) {
  const temCadencia = eventoTemCadencia(eventName);
  const [aberto, setAberto] = useState(abrirDeInicio);
  const [templateNome, setTemplateNome] = useState(configExistente?.template || '');
  const [cadencia, setCadencia] = useState(() => cadenciaInicial(eventName, configExistente));
  const configurado = !!configExistente?.template;
  const [msg, setMsg] = useState<{ tipo: 'nota' | 'erro'; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);

  const listaId = 'ad-vinculo-templates-' + loja + '-' + eventName.replace(/[^a-z0-9]/gi, '_');
  const templateSelecionado = templates.find((t) => t.name === templateNome);
  const textos = templateSelecionado ? extrairTextosComponentes(templateSelecionado.components) : null;

  function salvar() {
    setMsg(null);
    if (!templates.some((t) => t.name === templateNome)) {
      setMsg({ tipo: 'erro', texto: 'digite/selecione um template válido da lista' });
      return;
    }
    const body: Record<string, unknown> = { template: templateNome, ...(temCadencia ? cadenciaParaBody(cadencia) : {}) };
    setSalvando(true);
    salvarVinculo(eventName, body)
      .then(() => {
        setMsg({ tipo: 'nota', texto: 'salvo!' });
        recarregar();
      })
      .catch((err: Error) => setMsg({ tipo: 'erro', texto: err.message }))
      .finally(() => setSalvando(false));
  }

  async function remover() {
    await removerVinculo(eventName, 'api');
    recarregar();
  }

  return (
    <div className="ad-vinculo-card">
      <div className="ad-vinculo-topo">
        <strong>{eventoLabel(eventName)}</strong>
        {eventoLabel(eventName) !== eventName && <code className="ad-evento-codigo">{eventName}</code>}
        <StatusBadge tone={configurado ? 'success' : 'neutral'} label={configurado ? `Template: ${configExistente?.template}` : 'Não configurado'} />
        <Button variant="ghost" onClick={() => setAberto((v) => !v)}>
          {aberto ? 'Esconder' : configurado ? 'Editar' : 'Configurar'}
        </Button>
      </div>

      {aberto && (
        <div className="ad-vinculo-form">
          <Field label="Template">
            <input
              className="ds-input"
              type="text"
              placeholder="Digite pra buscar…"
              list={listaId}
              value={templateNome}
              onChange={(e) => setTemplateNome(e.target.value)}
            />
          </Field>
          <datalist id={listaId}>
            {templates.map((t) => (
              <option key={t.name} value={t.name} label={`${t.name} (${t.status})`} />
            ))}
          </datalist>

          {/* Preview só da estrutura do template (sem substituir {{n}} — qual campo vai em cada
              posição não se escolhe aqui, se configura em Templates). */}
          <PreviewWhatsapp
            headerTexto={textos?.header}
            headerChaves={[]}
            corpoTexto={textos?.corpo}
            corpoChaves={[]}
            footer={textos?.footer}
            botoes={textos?.botoes}
          />

          {templateSelecionado && (
            <Link className="ds-btn ds-btn--ghost" to={`/admin/templates/detalhe?nome=${encodeURIComponent(templateSelecionado.name)}`}>
              Configurar campos do template
            </Link>
          )}

          {temCadencia && <CadenciaCampos valor={cadencia} onChange={setCadencia} />}

          <p className="pc-nota">Qual dado vai em cada campo do template se configura em Templates → Ver/configurar.</p>

          {msg && (
            <p className={msg.tipo === 'erro' ? 'ds-form-error' : 'ds-form-note'} role={msg.tipo === 'erro' ? 'alert' : undefined}>
              {msg.texto}
            </p>
          )}
          <FormActions
            start={
              configurado && (
                <Button variant="danger" onClick={() => setConfirmandoRemocao(true)}>
                  Remover vínculo
                </Button>
              )
            }
          >
            <Button disabled={salvando} onClick={salvar}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </Button>
          </FormActions>
          <ConfirmDialog
            open={confirmandoRemocao}
            onClose={() => setConfirmandoRemocao(false)}
            title={`Remover a automação do evento "${eventName}" na ${adminStores.name(loja)}?`}
            confirmLabel="Remover"
            onConfirm={remover}
          />
        </div>
      )}
    </div>
  );
}

// Vínculo evento→mensagem no modo WhatsApp Web. Só lista mensagens compatíveis com o evento
// (carrinho só com carrinho/comum; o resto só com pedido/comum) — mesma regra que o servidor valida.
function VinculoCardWeb({
  loja,
  eventName,
  mensagens,
  configExistente,
  recarregar,
  abrirDeInicio,
}: {
  loja: string;
  eventName: string;
  mensagens: MensagemWeb[];
  configExistente: VinculoConfig | null;
  recarregar: () => void;
  abrirDeInicio: boolean;
}) {
  const temCadencia = eventoTemCadencia(eventName);
  const tipoDoEvento = eventoEhDeCarrinho(eventName) ? 'carrinho' : 'pedido';
  const compativeis = mensagens.filter((m) => m.tipo === 'comum' || m.tipo === tipoDoEvento);
  const [aberto, setAberto] = useState(abrirDeInicio);
  const [mensagemId, setMensagemId] = useState(configExistente?.mensagemWeb || '');
  const [cadencia, setCadencia] = useState(() => cadenciaInicial(eventName, configExistente));
  const [msg, setMsg] = useState<{ tipo: 'nota' | 'erro'; texto: string } | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);

  const vinculada = mensagens.find((m) => m.id === configExistente?.mensagemWeb) || null;
  const selecionada = mensagens.find((m) => m.id === mensagemId) || null;
  const configurado = !!configExistente?.mensagemWeb;

  function salvar() {
    setMsg(null);
    if (!selecionada) {
      setMsg({ tipo: 'erro', texto: 'selecione uma mensagem' });
      return;
    }
    setSalvando(true);
    salvarVinculoWeb(eventName, { mensagemWeb: mensagemId, ...(temCadencia ? cadenciaParaBody(cadencia) : {}) })
      .then(() => {
        setMsg({ tipo: 'nota', texto: 'salvo!' });
        recarregar();
      })
      .catch((err: Error) => setMsg({ tipo: 'erro', texto: err.message }))
      .finally(() => setSalvando(false));
  }

  async function remover() {
    await removerVinculo(eventName, 'web');
    recarregar();
  }

  return (
    <div className="ad-vinculo-card">
      <div className="ad-vinculo-topo">
        <strong>{eventoLabel(eventName)}</strong>
        {eventoLabel(eventName) !== eventName && <code className="ad-evento-codigo">{eventName}</code>}
        <StatusBadge
          tone={configurado ? (vinculada ? 'success' : 'danger') : 'neutral'}
          label={configurado ? (vinculada ? `Mensagem: ${vinculada.nome}` : 'Mensagem excluída') : 'Não configurado'}
        />
        <Button variant="ghost" onClick={() => setAberto((v) => !v)}>
          {aberto ? 'Esconder' : configurado ? 'Editar' : 'Configurar'}
        </Button>
      </div>

      {aberto && (
        <div className="ad-vinculo-form">
          {compativeis.length === 0 ? (
            <p className="pc-nota">
              Nenhuma mensagem do tipo "{tipoDoEvento === 'carrinho' ? 'carrinho abandonado' : 'pedido'}" ou "comum" ainda.{' '}
              <Link to="/admin/mensagens/nova">Criar mensagem</Link>
            </p>
          ) : (
            <Field label="Mensagem">
              <select className="ds-select" value={mensagemId} onChange={(e) => setMensagemId(e.target.value)}>
                <option value="">Selecione…</option>
                {compativeis.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.nome}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <PreviewMensagemWeb corpo={selecionada?.corpo || ''} />

          {selecionada && (
            <Link className="ds-btn ds-btn--ghost" to={`/admin/mensagens/${selecionada.id}`}>
              Editar texto da mensagem
            </Link>
          )}

          {temCadencia && <CadenciaCampos valor={cadencia} onChange={setCadencia} />}

          {msg && (
            <p className={msg.tipo === 'erro' ? 'ds-form-error' : 'ds-form-note'} role={msg.tipo === 'erro' ? 'alert' : undefined}>
              {msg.texto}
            </p>
          )}
          <FormActions
            start={
              configurado && (
                <Button variant="danger" onClick={() => setConfirmandoRemocao(true)}>
                  Remover vínculo
                </Button>
              )
            }
          >
            <Button disabled={salvando || !compativeis.length} onClick={salvar}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </Button>
          </FormActions>
          <ConfirmDialog
            open={confirmandoRemocao}
            onClose={() => setConfirmandoRemocao(false)}
            title={`Remover a mensagem do evento "${eventName}" na ${adminStores.name(loja)}?`}
            description="Só o vínculo do WhatsApp Web é removido; o template da API da Meta (se houver) continua configurado."
            confirmLabel="Remover"
            onConfirm={remover}
          />
        </div>
      )}
    </div>
  );
}

function LojaSection({
  loja,
  templates,
  mensagens,
  modoWeb,
  eventosConfigLoja,
  logDaLoja,
  recarregar,
}: {
  loja: string;
  templates: WhatsappTemplate[];
  mensagens: MensagemWeb[];
  modoWeb: boolean;
  eventosConfigLoja: Record<string, VinculoConfig>;
  logDaLoja: WebhookEvento[];
  recarregar: () => void;
}) {
  const nomesObservados = Array.from(new Set(logDaLoja.map((e) => e.eventName).filter((n): n is string => !!n)));
  // pix.pendente é sintético (nunca aparece no webhook-log) — sempre disponível pra configurar.
  const baseNomes = Array.from(new Set([...nomesObservados, ...Object.keys(eventosConfigLoja), EVENTO_PIX_PENDENTE])).sort();
  const [extras, setExtras] = useState<string[]>([]);
  const [addValue, setAddValue] = useState('');
  const [addErro, setAddErro] = useState('');

  const todosNomes = [...baseNomes, ...extras.filter((n) => !baseNomes.includes(n))];

  function adicionar() {
    const nome = addValue.trim();
    if (!nome) {
      setAddErro('Digite o nome do evento antes de vincular.');
      return;
    }
    if (todosNomes.includes(nome)) {
      setAddErro('Esse evento já está na lista acima.');
      return;
    }
    setAddErro('');
    setExtras((prev) => [...prev, nome]);
    setAddValue('');
  }

  return (
    <Card title={adminStores.name(loja)}>
      <div className="ad-vinculos-lista">
        {!todosNomes.length ? (
          <EmptyState title="Nenhum evento observado ainda pra essa loja" description="Confira em Eventos, ou adicione manualmente abaixo." />
        ) : (
          todosNomes.map((nome) =>
            modoWeb ? (
              <VinculoCardWeb
                key={nome}
                loja={loja}
                eventName={nome}
                mensagens={mensagens}
                configExistente={eventosConfigLoja[nome] || null}
                recarregar={recarregar}
                abrirDeInicio={extras.includes(nome) && !baseNomes.includes(nome)}
              />
            ) : (
              <VinculoCard
                key={nome}
                loja={loja}
                eventName={nome}
                templates={templates}
                configExistente={eventosConfigLoja[nome] || null}
                recarregar={recarregar}
                abrirDeInicio={extras.includes(nome) && !baseNomes.includes(nome)}
              />
            ),
          )
        )}
      </div>
      <div className="ad-vinculo-add">
        <input
          className="ds-input"
          type="text"
          aria-label="Código do evento"
          placeholder="ex: payment.approved (evento ainda não observado)"
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
        />
        <Button variant="ghost" onClick={adicionar}>
          + Vincular novo evento
        </Button>
        {addErro && <span className="ds-form-error">{addErro}</span>}
      </div>
    </Card>
  );
}

// Sequência de eventos da Reserva Ink decifrada observando o webhook-log (a INK não documenta
// isso em lugar nenhum) — só um mapa de referência, não usado pra validar nada.
function FluxoEventosCard() {
  function Chip({ nome, variante }: { nome: string; variante?: 'erro' | 'ok' }) {
    return <span className={'ad-fluxo-chip' + (variante ? ` ad-fluxo-chip--${variante}` : '')}>{nome}</span>;
  }
  function Ramo({ passos }: { passos: { nome: string; variante?: 'erro' | 'ok' }[] }) {
    return (
      <div className="ad-fluxo-eventos__ramo">
        {passos.map((passo, i) => (
          <Fragment key={passo.nome}>
            {i > 0 && <span className="ad-fluxo-seta" aria-hidden="true">→</span>}
            <Chip nome={passo.nome} variante={passo.variante} />
          </Fragment>
        ))}
      </div>
    );
  }

  return (
    <Card title="Sequência de eventos (referência)">
      <p className="pc-nota">Decifrado observando o webhook-log, a Reserva Ink não documenta isso oficialmente — confirme em Eventos se um evento novo não estiver aqui.</p>
      <div className="ad-fluxo-eventos">
        <div className="ad-fluxo-eventos__origem">
          <Chip nome="order.created" />
        </div>
        <div className="ad-fluxo-eventos__ramos">
          <Ramo passos={[{ nome: 'payment.card_not_authorized', variante: 'erro' }, { nome: 'order.canceled', variante: 'erro' }]} />
          <Ramo passos={[{ nome: 'payment.pix_boleto_expired', variante: 'erro' }, { nome: 'order.canceled', variante: 'erro' }]} />
          <Ramo passos={[{ nome: 'pix.pendente *' }]} />
          <Ramo
            passos={[
              { nome: 'payment.approved', variante: 'ok' },
              { nome: 'shipping.waiting_to_be_sent' },
              { nome: 'shipping.sent' },
              { nome: 'shipping.delivery_in_progress' },
              { nome: 'shipping.left_for_delivery' },
              { nome: 'shipping.delivered', variante: 'ok' },
            ]}
          />
        </div>
      </div>
      <p className="pc-nota">
        * pix.pendente é um evento nosso (não vem da Reserva Ink) — criado sozinho junto com order.created quando o pedido chega com Pix aguardando
        pagamento. Tem a mesma cadência de reenvio do carrinho abandonado.
      </p>
    </Card>
  );
}

export function AutomacoesPage() {
  const escopo = useLojaAtiva() ?? '';
  const [dados, setDados] = useState<{
    settings: AutomationSettings;
    templates: WhatsappTemplate[];
    mensagens: MensagemWeb[];
    eventosConfig: EventosConfigPorLoja;
    log: WebhookEvento[];
  } | null>(null);
  const [erro, setErro] = useState('');
  const [geracao, setGeracao] = useState(0);

  function carregar() {
    setErro('');
    // Modo WhatsApp Web não depende da Meta: busca as mensagens próprias em vez dos templates
    // (que falhariam sem o serviço de WhatsApp configurado).
    getAutomationSettings()
      .then((settings) => {
        const modoWeb = settings.provider === 'whatsapp_web';
        return Promise.all([
          settings,
          modoWeb ? Promise.resolve({ templates: [] as WhatsappTemplate[] }) : getWhatsappTemplates(),
          modoWeb ? listarMensagensWeb() : Promise.resolve({ mensagens: [] as MensagemWeb[] }),
          getAutomacaoEventos(),
          getWebhookLogAutomacoes(),
          getCamposCustomizadosRefs(),
        ]);
      })
      .then(([settings, templatesRes, mensagensRes, eventosRes, logRes, camposRes]) => {
        definirCamposCustomizados(Object.keys(camposRes.campos || {}).map((chave) => ({ chave, label: camposRes.campos[chave].label })));
        setDados({
          settings,
          templates: templatesRes.templates || [],
          mensagens: mensagensRes.mensagens || [],
          eventosConfig: eventosRes.eventos || {},
          log: logRes.log || [],
        });
        setGeracao((g) => g + 1);
      })
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [escopo]);

  if (erro) {
    return (
      <>
        <PageHeader title="Automações" />
        <ErrorState description={erro} onRetry={carregar} />
      </>
    );
  }

  if (!dados) {
    return (
      <>
        <PageHeader title="Automações" />
        <Skeleton rows={6} />
      </>
    );
  }

  // Uma loja só: a da Organization ativa.
  const lojas = escopo ? [escopo] : [];
  const modoWeb = dados.settings.provider === 'whatsapp_web';

  return (
    <>
      <PageHeader
        title="Automações"
        description={
          modoWeb
            ? 'Escolha qual mensagem do WhatsApp Web dispara cada evento da Reserva Ink, por loja.'
            : 'Escolha qual template dispara cada evento da Reserva Ink, por loja.'
        }
        actions={
          <InfoTooltip
            content={
              modoWeb
                ? 'Cada loja pode usar uma mensagem diferente pro mesmo evento. Os textos são criados em Mensagens. Carrinho abandonado e Pix pendente têm configs extras de reenvio, pra não virar spam. Os vínculos com templates da API continuam guardados.'
                : 'Cada loja pode usar um template diferente pro mesmo evento. Use o seletor no topo pra trocar de loja. Carrinho abandonado tem configs extras de reenvio, pra não virar spam. Qual dado vai em cada campo do template é configurado em Templates.'
            }
          />
        }
      />
      <div className="ad-automacoes-grid">
        <FluxoEventosCard />
        <EnvioSwitch dados={dados.settings} recarregar={carregar} />
        {lojas.map((loja) => (
          <LojaSection
            key={loja + '#' + geracao}
            loja={loja}
            templates={dados.templates}
            mensagens={dados.mensagens}
            modoWeb={modoWeb}
            eventosConfigLoja={dados.eventosConfig[loja] || {}}
            logDaLoja={dados.log.filter((e) => e.loja === loja)}
            recarregar={carregar}
          />
        ))}
      </div>
    </>
  );
}
