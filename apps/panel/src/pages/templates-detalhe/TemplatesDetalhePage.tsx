import { useChaveDaStore } from '../../auth/AuthContext';
import { Fragment, useEffect, useId, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Callout, Card, ConfirmDialog, ErrorState, Field, FormActions, FormGrid, FormStack, Input, MediaDropzone, Modal, PageHeader, PageStack, Skeleton, StatusBadge } from '../../components/ds';
import {
  CamposVariaveis,
  PreviewWhatsapp,
  camposVariaveisValido,
  type CamposVariaveisValue,
} from '../../components/template-editor';
import {
  construirOverridesCampos,
  definirCamposCustomizados,
  extrairBotaoDinamico,
  extrairTextosComponentes,
  extrairTokensVariaveis,
} from '../../lib/templateVariables';
import { eventoLabel, idiomaLabel, templateCategoriaLabel } from '../../lib/eventLabels';
import { lookup, TEMPLATE_META_STATUS_MAP } from '../../lib/statusMap';
import { adminStores } from '../../state/adminStores';
import {
  deleteAutomacaoEvento,
  deleteTemplate,
  listAutomacaoEventos,
  listCamposCustomizados,
  listTemplates,
  listWebhookLog,
  putAutomacaoEvento,
  testarTemplate,
  vincularAmostraTemplate,
  type AutomacaoEventoConfig,
  type CampoCustomizadoAPI,
  type WebhookLogEntry,
  type WhatsappTemplate,
} from '../../api/templates';
import { uploadMedia, type MediaAsset } from '../../api/media';

import '../../pedidos-central.css';
import '../../templates.css';

// Porte de src/templates-detalhe.js.

const BOTAO_TIPO_LABEL: Record<string, string> = { QUICK_REPLY: 'Resposta rápida', URL: 'Link', PHONE_NUMBER: 'Telefone' };
const EVENTO_PIX_PENDENTE = 'pix.pendente';

function eventoEhDeCarrinho(nome: string | null | undefined): boolean {
  if (!nome) return false;
  const n = nome.toLowerCase();
  return n.includes('cart') || n.includes('carrinho');
}
function eventoTemCadencia(nome: string): boolean {
  return eventoEhDeCarrinho(nome) || nome === EVENTO_PIX_PENDENTE;
}
function coletarEventosConhecidos(eventosConfig: Record<string, Record<string, unknown>>, webhookLog: WebhookLogEntry[]): string[] {
  const vistos: Record<string, boolean> = {};
  Object.keys(eventosConfig || {}).forEach((loja) => {
    Object.keys(eventosConfig[loja] || {}).forEach((evento) => {
      vistos[evento] = true;
    });
  });
  (webhookLog || []).forEach((e) => {
    if (e.eventName) vistos[e.eventName] = true;
  });
  vistos[EVENTO_PIX_PENDENTE] = true;
  return Object.keys(vistos).sort();
}

const HEADER_MEDIA_LABEL_DETALHE: Record<string, string> = {
  IMAGE: '🖼 Imagem', VIDEO: '▶ Vídeo', DOCUMENT: '▣ Documento', LOCATION: '⌖ Localização',
};

function TemplateConteudo({ t }: { t: WhatsappTemplate }) {
  const textos = extrairTextosComponentes(t.components);
  // A Meta não devolve o arquivo/handle de volta na listagem de templates (só na criação) — só
  // dá pra mostrar QUE tipo de mídia o cabeçalho aprovado usa, não reexibir o arquivo em si.
  const headerComp = (t.components || []).find((c) => c.type === 'HEADER');
  const headerMediaTipo = headerComp && headerComp.format && headerComp.format !== 'TEXT' ? headerComp.format : null;
  return (
    <div className="ad-template-detalhes">
      {headerMediaTipo && (
        <>
          <div className="ad-template-detalhes__label">Cabeçalho</div>
          <div className="ad-template-detalhes__valor">{HEADER_MEDIA_LABEL_DETALHE[headerMediaTipo] || headerMediaTipo}</div>
        </>
      )}
      {textos.header && (
        <>
          <div className="ad-template-detalhes__label">Cabeçalho</div>
          <div className="ad-template-detalhes__valor">{textos.header}</div>
        </>
      )}
      <div className="ad-template-detalhes__label">Corpo</div>
      <div className="ad-template-detalhes__valor">{textos.corpo || ''}</div>
      {textos.footer && (
        <>
          <div className="ad-template-detalhes__label">Rodapé</div>
          <div className="ad-template-detalhes__valor">{textos.footer}</div>
        </>
      )}
      {(textos.botoes || []).map((b, i) => (
        <Fragment key={i}>
          <div className="ad-template-detalhes__label">Botão · {BOTAO_TIPO_LABEL[b.tipo] || b.tipo}</div>
          <div className="ad-template-detalhes__valor">
            {b.texto}
            {b.valor ? ' — ' + b.valor : ''}
          </div>
        </Fragment>
      ))}
      <div className="ad-template-detalhes__ressalva">
        Esse conteúdo é fixo, do jeito que foi aprovado pela Meta — mudar texto ou botão exige criar um template novo (editar um já aprovado e
        reenviar pra análise ainda não é suportado aqui).
      </div>
    </div>
  );
}

function TesteInline({ t }: { t: WhatsappTemplate }) {
  const textos = extrairTextosComponentes(t.components);
  const headerTokens = extrairTokensVariaveis(textos.header || '');
  const corpoTokens = extrairTokensVariaveis(textos.corpo || '');
  const botaoInfo = extrairBotaoDinamico(t.components);

  const [headerVal, setHeaderVal] = useState('');
  const [corpoVals, setCorpoVals] = useState<string[]>(() => corpoTokens.map(() => ''));
  const [botaoVal, setBotaoVal] = useState('');
  const [telefone, setTelefone] = useState('');
  const [status, setStatus] = useState<{ texto: string; erro: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);

  function enviar() {
    setStatus(null);
    if (!telefone.trim()) {
      setStatus({ texto: 'informe um telefone', erro: true });
      return;
    }
    setEnviando(true);
    testarTemplate(t.name, {
      telefone: telefone.trim(),
      valores: {
        header: headerTokens.length ? headerVal : undefined,
        corpo: corpoVals,
        botao: botaoInfo ? botaoVal : undefined,
      },
    })
      .then(() => setStatus({ texto: 'enviado!', erro: false }))
      .catch((err: Error) => setStatus({ texto: err.message, erro: true }))
      .finally(() => setEnviando(false));
  }

  const temParams = headerTokens.length > 0 || corpoTokens.length > 0 || !!botaoInfo;

  return (
    <FormStack as="div">
      {temParams && (
        <FormGrid>
          {headerTokens.length > 0 && (
            <Field label={`Cabeçalho — {{${headerTokens[0]}}}`}>
              <Input type="text" placeholder="ex: Exemplo" value={headerVal} onChange={(e) => setHeaderVal(e.target.value)} />
            </Field>
          )}
          {corpoTokens.map((token, i) => (
            <Field key={i} label={`Corpo — {{${token}}}`}>
              <Input
                type="text"
                placeholder="ex: Exemplo"
                value={corpoVals[i] || ''}
                onChange={(e) => {
                  const next = corpoVals.slice();
                  next[i] = e.target.value;
                  setCorpoVals(next);
                }}
              />
            </Field>
          ))}
          {botaoInfo && (
            <Field label="Botão de link — valor do {{1}} na URL">
              <Input type="text" placeholder="ex: exemplo123" value={botaoVal} onChange={(e) => setBotaoVal(e.target.value)} />
            </Field>
          )}
        </FormGrid>
      )}
      <Field label="Telefone com DDD">
        <Input type="tel" inputMode="tel" placeholder="ex: 48999998888" value={telefone} onChange={(e) => setTelefone(e.target.value)} />
      </Field>
      {status && (
        <p className={status.erro ? 'ds-form-error' : 'ds-form-note'} role={status.erro ? 'alert' : undefined}>
          {status.texto}
        </p>
      )}
      <FormActions>
        <Button variant="secondary" disabled={enviando} onClick={enviar}>
          {enviando ? 'Enviando…' : 'Enviar teste'}
        </Button>
      </FormActions>
    </FormStack>
  );
}

const MAPA_ACCEPT_DROPZONE = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' } as const;

// Só aparece quando o template tem header de mídia/localização na Meta mas não tem
// sampleMediaAssetId/sampleLocation salvo aqui (template criado antes dessa config existir, ou
// direto no Gerenciador da Meta) — sem isso, "enviar teste" e os disparos automáticos falham com
// 132012 "Format mismatch... received UNKNOWN" por não terem o que reenviar no header.
function AmostraModal({ nome, headerMediaTipo, open, onClose, onSalvo }: {
  nome: string;
  headerMediaTipo: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
  open: boolean;
  onClose: () => void;
  onSalvo: () => void;
}) {
  const [sampleMediaAsset, setSampleMediaAsset] = useState<MediaAsset | null>(null);
  const [sampleMediaErro, setSampleMediaErro] = useState<string | null>(null);
  const [sampleLocationNome, setSampleLocationNome] = useState('');
  const [sampleLocationEndereco, setSampleLocationEndereco] = useState('');
  const [sampleLocationLat, setSampleLocationLat] = useState('');
  const [sampleLocationLng, setSampleLocationLng] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    setErro('');
    if (headerMediaTipo !== 'LOCATION' && !sampleMediaAsset) {
      setErro('Envie um arquivo de amostra pro cabeçalho antes de continuar.');
      return;
    }
    if (headerMediaTipo === 'LOCATION' && (!sampleLocationNome.trim() || !sampleLocationLat.trim() || !sampleLocationLng.trim())) {
      setErro('Preencha nome, latitude e longitude da amostra de localização.');
      return;
    }
    setSalvando(true);
    try {
      await vincularAmostraTemplate(nome, {
        headerTipo: headerMediaTipo,
        sampleMediaAssetId: sampleMediaAsset?.id ?? null,
        sampleLocation:
          headerMediaTipo === 'LOCATION'
            ? {
                nome: sampleLocationNome.trim(),
                endereco: sampleLocationEndereco.trim(),
                latitude: Number(sampleLocationLat),
                longitude: Number(sampleLocationLng),
              }
            : null,
      });
      onSalvo();
      onClose();
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Configurar amostra do cabeçalho" confirmLabel="Salvar" confirmDisabled={salvando} onConfirm={salvar}>
      <p className="pc-nota">
        Reenviada no "enviar teste" e nos disparos automáticos desse template — não é a mídia enviada em campanhas (isso é escolhido na
        própria campanha).
      </p>
      {headerMediaTipo !== 'LOCATION' && (
        <Field label="Arquivo de amostra">
          <MediaDropzone
            accept={MAPA_ACCEPT_DROPZONE[headerMediaTipo]}
            erro={sampleMediaErro}
            value={sampleMediaAsset ? { filename: sampleMediaAsset.filename, sizeBytes: sampleMediaAsset.sizeBytes, previewUrl: sampleMediaAsset.previewUrl } : null}
            onUpload={async (file) => {
              setSampleMediaErro(null);
              const resultado = await uploadMedia(file);
              if (resultado.avisoMeta) setSampleMediaErro(resultado.avisoMeta);
              setSampleMediaAsset(resultado.asset);
            }}
            onRemove={() => {
              setSampleMediaAsset(null);
              setSampleMediaErro(null);
            }}
          />
        </Field>
      )}
      {headerMediaTipo === 'LOCATION' && (
        <>
          <Field label="Nome/local da amostra">
            <Input type="text" placeholder="ex: Loja Centro" value={sampleLocationNome} onChange={(e) => setSampleLocationNome(e.target.value)} />
          </Field>
          <Field label="Endereço da amostra (opcional)">
            <Input type="text" placeholder="ex: Rua Exemplo, 123" value={sampleLocationEndereco} onChange={(e) => setSampleLocationEndereco(e.target.value)} />
          </Field>
          <div className="ad-campo-linha">
            <Field label="Latitude">
              <Input type="number" step="any" placeholder="-27.5954" value={sampleLocationLat} onChange={(e) => setSampleLocationLat(e.target.value)} />
            </Field>
            <Field label="Longitude">
              <Input type="number" step="any" placeholder="-48.5480" value={sampleLocationLng} onChange={(e) => setSampleLocationLng(e.target.value)} />
            </Field>
          </div>
        </>
      )}
      {erro && <p className="ds-form-error">{erro}</p>}
    </Modal>
  );
}

function AmostraAusenteAviso({ t, recarregar }: { t: WhatsappTemplate; recarregar: () => void }) {
  const [modalAberto, setModalAberto] = useState(false);
  const headerComp = (t.components || []).find((c) => c.type === 'HEADER');
  const headerMediaTipo = headerComp && headerComp.format && headerComp.format !== 'TEXT' ? (headerComp.format as 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION') : null;
  const temAmostra = headerMediaTipo === 'LOCATION' ? !!t.config?.sampleLocation : !!t.config?.sampleMediaAssetId;
  if (!headerMediaTipo || temAmostra) return null;

  return (
    <Callout
      tone="warning"
      title="Falta a amostra do cabeçalho"
      action={
        <Button variant="secondary" size="sm" onClick={() => setModalAberto(true)}>
          Configurar amostra
        </Button>
      }
    >
      Esse template tem cabeçalho de {HEADER_MEDIA_LABEL_DETALHE[headerMediaTipo] || headerMediaTipo.toLowerCase()}, mas não há amostra
      configurada localmente — "enviar teste" e disparos automáticos vão falhar até configurar.
      <AmostraModal
        nome={t.name}
        headerMediaTipo={headerMediaTipo}
        open={modalAberto}
        onClose={() => setModalAberto(false)}
        onSalvo={recarregar}
      />
    </Callout>
  );
}

interface VinculoFormProps {
  t: WhatsappTemplate;
  loja: string;
  evento: string;
  configExistente: AutomacaoEventoConfig | null;
  campos: Record<string, CampoCustomizadoAPI>;
  recarregar: () => void;
  aoRemover?: () => void;
}

function VinculoForm({ t, loja, evento, configExistente, campos, recarregar, aoRemover }: VinculoFormProps) {
  const temCadencia = eventoTemCadencia(evento);
  const [camposVarsValue, setCamposVarsValue] = useState<CamposVariaveisValue>({
    headerVariavel: configExistente?.headerVariavel ?? null,
    corpoVariaveis: configExistente?.corpoVariaveis ?? [],
    botaoVariavel: configExistente?.botaoVariavel ?? null,
  });
  const [atraso, setAtraso] = useState(configExistente?.atrasoPrimeiroEnvioHoras ?? (evento === EVENTO_PIX_PENDENTE ? 4 : 24));
  const [maxEnvios, setMaxEnvios] = useState(configExistente?.maxEnvios ?? 1);
  const [intervalo, setIntervalo] = useState(configExistente?.intervaloHoras ?? 24);
  const [checarCompra, setCheckarCompra] = useState(configExistente ? configExistente.checarCompra !== false : true);
  const [msg, setMsg] = useState<{ texto: string; erro: boolean } | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);

  const textosTemplate = extrairTextosComponentes(t.components);
  const overridesCustom = construirOverridesCampos(campos, loja);
  const botaoInfo = extrairBotaoDinamico(t.components);
  const botoesComChave = (textosTemplate.botoes || []).map((b, i) =>
    botaoInfo && i === botaoInfo.indice ? { ...b, chave: camposVarsValue.botaoVariavel } : b,
  );

  function salvar() {
    setMsg(null);
    if (!camposVariaveisValido(camposVarsValue, t)) {
      setMsg({ texto: 'preencha todas as variáveis', erro: true });
      return;
    }
    const body: AutomacaoEventoConfig = {
      template: t.name,
      headerVariavel: camposVarsValue.headerVariavel,
      corpoVariaveis: camposVarsValue.corpoVariaveis,
      botaoVariavel: camposVarsValue.botaoVariavel,
    };
    if (temCadencia) {
      body.atrasoPrimeiroEnvioHoras = Number(atraso) || 0;
      body.maxEnvios = Math.trunc(Number(maxEnvios)) || 1;
      body.intervaloHoras = Number(intervalo) || 24;
      body.checarCompra = checarCompra;
    }
    setSalvando(true);
    putAutomacaoEvento(evento, body)
      .then(() => {
        setMsg({ texto: 'salvo!', erro: false });
        recarregar();
      })
      .catch((err: Error) => setMsg({ texto: err.message, erro: true }))
      .finally(() => setSalvando(false));
  }

  async function remover() {
    await deleteAutomacaoEvento(evento);
    recarregar();
  }

  return (
    <div className="ad-vinculo-form-inline">
      <PreviewWhatsapp
        headerTexto={textosTemplate.header}
        headerChaves={[camposVarsValue.headerVariavel]}
        corpoTexto={textosTemplate.corpo}
        corpoChaves={camposVarsValue.corpoVariaveis}
        footer={textosTemplate.footer}
        botoes={botoesComChave}
        overrides={overridesCustom}
      />
      <CamposVariaveis template={t} value={camposVarsValue} onChange={setCamposVarsValue} />

      {temCadencia && (
        <div className="ad-vinculo-carrinho">
          <p className="pc-nota">Reenvia até o limite abaixo, respeitando o intervalo, e para de reenviar se o cliente já comprou (ou já pagou o Pix).</p>
          <FormGrid min={180}>
            <Field label="Espera antes do 1º envio" hint="Em horas.">
              <Input type="number" min={0} max={720} value={atraso} onChange={(e) => setAtraso(Number(e.target.value))} />
            </Field>
            <Field label="Quantas vezes enviar" hint="1 = só a mensagem inicial, sem reenvio.">
              <Input type="number" min={1} max={10} value={maxEnvios} onChange={(e) => setMaxEnvios(Number(e.target.value))} />
            </Field>
            <Field label="Intervalo entre envios" hint="Em horas.">
              <Input type="number" min={1} max={720} value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))} />
            </Field>
          </FormGrid>
          <label className="ad-vinculo-checar">
            <input type="checkbox" checked={checarCompra} onChange={(e) => setCheckarCompra(e.target.checked)} /> Não reenviar se o cliente já
            comprou desde o último envio
          </label>
        </div>
      )}

      {msg && (
        <p className={msg.erro ? 'ds-form-error' : 'ds-form-note'} role={msg.erro ? 'alert' : undefined}>
          {msg.texto}
        </p>
      )}
      <FormActions
        start={
          configExistente ? (
            <Button variant="danger" onClick={() => setConfirmandoRemocao(true)}>
              Remover vínculo
            </Button>
          ) : aoRemover ? (
            <Button variant="ghost" onClick={aoRemover}>
              Cancelar
            </Button>
          ) : null
        }
      >
        <Button disabled={salvando} onClick={salvar}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </Button>
      </FormActions>
      <ConfirmDialog
        open={confirmandoRemocao}
        onClose={() => setConfirmandoRemocao(false)}
        title={`Remover a automação do evento "${evento}" na ${adminStores.name(loja)}?`}
        confirmLabel="Remover"
        onConfirm={remover}
      />
    </div>
  );
}

// Combobox (padrão ARIA 1.2): setas percorrem as sugestões, Enter escolhe, Esc fecha. O foco fica
// sempre no campo; a opção ativa é anunciada via aria-activedescendant.
function EventoAutocompleteInput({ value, onChange, sugestoes }: { value: string; onChange: (v: string) => void; sugestoes: string[] }) {
  const [mostrar, setMostrar] = useState(false);
  const [ativa, setAtiva] = useState(-1);
  const baseId = useId();
  const termo = value.trim().toLowerCase();
  const filtrados = sugestoes.filter((nome) => !termo || nome.toLowerCase().includes(termo) || eventoLabel(nome).toLowerCase().includes(termo));
  const aberta = mostrar && filtrados.length > 0;

  function escolher(nome: string) {
    onChange(nome);
    setMostrar(false);
    setAtiva(-1);
  }

  return (
    <div className="ad-evento-autocomplete">
      <Input
        type="text"
        role="combobox"
        aria-label="Código do evento"
        aria-expanded={aberta}
        aria-controls={`${baseId}-lista`}
        aria-autocomplete="list"
        aria-activedescendant={aberta && ativa >= 0 ? `${baseId}-op-${ativa}` : undefined}
        placeholder="ex: payment.approved"
        autoComplete="off"
        value={value}
        onFocus={() => setMostrar(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setMostrar(true);
          setAtiva(-1);
        }}
        onBlur={() => setMostrar(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setMostrar(true);
            setAtiva((i) => (filtrados.length ? (i + 1) % filtrados.length : -1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAtiva((i) => (filtrados.length ? (i <= 0 ? filtrados.length - 1 : i - 1) : -1));
          } else if (e.key === 'Enter' && aberta && ativa >= 0) {
            e.preventDefault();
            escolher(filtrados[ativa]);
          } else if (e.key === 'Escape') {
            setMostrar(false);
            setAtiva(-1);
          }
        }}
      />
      {aberta && (
        <div className="ad-evento-autocomplete__lista" role="listbox" id={`${baseId}-lista`} aria-label="Eventos conhecidos">
          {filtrados.map((nome, i) => (
            <div
              key={nome}
              id={`${baseId}-op-${i}`}
              role="option"
              aria-selected={i === ativa}
              className={'ad-evento-autocomplete__item' + (i === ativa ? ' ad-evento-autocomplete__item--ativa' : '')}
              onMouseDown={(ev) => {
                ev.preventDefault();
                escolher(nome);
              }}
              onMouseEnter={() => setAtiva(i)}
            >
              {eventoLabel(nome)}
              {eventoLabel(nome) !== nome && <code className="ad-evento-codigo">{nome}</code>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AutomacaoPanel({
  t,
  eventosConfig,
  webhookLog,
  campos,
  recarregar,
}: {
  t: WhatsappTemplate;
  eventosConfig: Record<string, Record<string, AutomacaoEventoConfig>>;
  webhookLog: WebhookLogEntry[];
  campos: Record<string, CampoCustomizadoAPI>;
  recarregar: () => void;
}) {
  // Loja da Organization ativa: o vínculo é sempre dela (o servidor decide o escopo).
  // Chave dos vínculos desta Store (legada ou store_id): é sob ela que o servidor os guarda.
  const selectLoja = useChaveDaStore();
  const [novoEvento, setNovoEvento] = useState('');
  const [novoVinculoAberto, setNovoVinculoAberto] = useState(false);
  const [vincularErro, setVincularErro] = useState('');

  const eventosConhecidos = coletarEventosConhecidos(eventosConfig, webhookLog);

  function vincular() {
    const evento = novoEvento.trim();
    if (!evento) {
      setVincularErro('Digite o nome do evento antes de vincular.');
      return;
    }
    const jaExiste = (t.eventos || []).some((v) => v.loja === selectLoja && v.evento === evento);
    if (jaExiste) {
      setVincularErro('Esse template já está vinculado a esse evento nessa loja.');
      return;
    }
    setVincularErro('');
    setNovoVinculoAberto(true);
  }

  return (
    <div className="ad-template-automacao">
      {(t.eventos || []).map((v) => (
        <div className="ad-vinculo-card" key={v.loja + '::' + v.evento}>
          <div className="ad-vinculo-topo">
            <strong>
              {adminStores.name(v.loja)} → {eventoLabel(v.evento)}
            </strong>
            {eventoLabel(v.evento) !== v.evento && <code className="ad-evento-codigo">{v.evento}</code>}
          </div>
          <VinculoForm
            t={t}
            loja={v.loja}
            evento={v.evento}
            configExistente={(eventosConfig[v.loja] || {})[v.evento] ?? null}
            campos={campos}
            recarregar={recarregar}
          />
        </div>
      ))}

      <div className="ad-vinculo-add">
        <EventoAutocompleteInput value={novoEvento} onChange={setNovoEvento} sugestoes={eventosConhecidos} />
        <Button variant="ghost" onClick={vincular}>
          + Vincular a um evento
        </Button>
        {vincularErro && <span className="ds-form-error">{vincularErro}</span>}
      </div>

      {novoVinculoAberto && (
        <VinculoForm
          t={t}
          loja={selectLoja}
          evento={novoEvento.trim()}
          configExistente={null}
          campos={campos}
          recarregar={recarregar}
          aoRemover={() => setNovoVinculoAberto(false)}
        />
      )}
    </div>
  );
}

export function TemplatesDetalhePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const nome = searchParams.get('nome');

  const [t, setT] = useState<WhatsappTemplate | null>(null);
  const [eventosConfig, setEventosConfig] = useState<Record<string, Record<string, AutomacaoEventoConfig>>>({});
  const [campos, setCampos] = useState<Record<string, CampoCustomizadoAPI>>({});
  const [webhookLog, setWebhookLog] = useState<WebhookLogEntry[]>([]);
  const [erro, setErro] = useState('');
  const [naoEncontrado, setNaoEncontrado] = useState(false);
  const [versao, setVersao] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);

  function carregar() {
    setCarregando(true);
    setErro('');
    setNaoEncontrado(false);
    Promise.all([listTemplates(), listAutomacaoEventos(), listCamposCustomizados(), listWebhookLog()])
      .then(([tData, eData, cData, wData]) => {
        const templates = tData.templates || [];
        const eventosConfigData = eData.eventos || {};
        const camposData = cData.campos || {};
        const webhookLogData = wData.log || [];
        definirCamposCustomizados(Object.keys(camposData).map((chave) => ({ chave, label: camposData[chave].label })));

        const found = templates.find((x) => x.name === nome) ?? null;
        setT(found);
        setNaoEncontrado(!found);
        setEventosConfig(eventosConfigData);
        setCampos(camposData);
        setWebhookLog(webhookLogData);
        setVersao((v) => v + 1);
        setCarregando(false);
      })
      .catch((err: Error) => {
        setErro(err.message);
        setCarregando(false);
      });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [nome]);

  async function excluir() {
    if (!t) return;
    await deleteTemplate(t.name);
    navigate('/admin/templates');
  }

  function duplicar() {
    if (!t) return;
    window.sessionStorage.setItem('ad_duplicar_template', JSON.stringify(t));
    navigate('/admin/templates/novo');
  }

  const statusMeta = t ? lookup(TEMPLATE_META_STATUS_MAP, t.status) : null;

  return (
    <PageStack>
      <PageHeader
        title={t?.name || nome || 'Template'}
        back={{ to: '/admin/templates', label: 'Voltar pra lista' }}
        meta={
          t &&
          statusMeta && (
            <>
              <StatusBadge tone={statusMeta.tone} label={statusMeta.label} />
              <span>
                {templateCategoriaLabel(t.category)} · {idiomaLabel(t.language)}
              </span>
            </>
          )
        }
        actions={
          t
            ? [
                <Button variant="secondary" onClick={duplicar}>
                  Duplicar
                </Button>,
                <Button variant="danger" onClick={() => setConfirmandoExclusao(true)}>
                  Excluir template
                </Button>,
              ]
            : undefined
        }
      />
      {!nome && <ErrorState description="Nenhum template informado." />}
      {nome && erro && <ErrorState description={erro} onRetry={carregar} />}
      {nome && !erro && carregando && <Skeleton rows={6} />}
      {nome && !erro && !carregando && naoEncontrado && <ErrorState description={`Template "${nome}" não encontrado.`} />}
      {nome && !erro && !carregando && t && (
        // key={versao}: mesmo efeito do vanilla limpar conteudo.innerHTML a cada carregar() —
        // remonta os formulários de vínculo (descarta estado transitório tipo "novo vínculo em
        // edição") toda vez que os dados são recarregados, em vez de tentar sincronizar manualmente.
        <Fragment key={versao}>
          <Card title="Conteúdo aprovado">
            <div className="ds-stack">
              {t.status === 'REJECTED' && t.rejected_reason && (
                <Callout tone="danger" title="Reprovado pela Meta">
                  {t.rejected_reason}
                </Callout>
              )}
              <AmostraAusenteAviso t={t} recarregar={carregar} />
              <TemplateConteudo t={t} />
            </div>
          </Card>

          {t.status === 'APPROVED' && (
            <Card title="Enviar teste" description="Usa dados de exemplo e não depende do vínculo abaixo.">
              <TesteInline t={t} />
            </Card>
          )}

          <Card title="Vínculo com evento" description="O campo escolhido aqui é só nosso, não precisa de aprovação da Meta.">
            <AutomacaoPanel t={t} eventosConfig={eventosConfig} webhookLog={webhookLog} campos={campos} recarregar={carregar} />
          </Card>
        </Fragment>
      )}
      {t && (
        <ConfirmDialog
          open={confirmandoExclusao}
          onClose={() => setConfirmandoExclusao(false)}
          title={`Excluir o template "${t.name}" da Meta?`}
          onConfirm={excluir}
        />
      )}
    </PageStack>
  );
}
