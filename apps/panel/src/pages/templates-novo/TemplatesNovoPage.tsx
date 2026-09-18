import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, ErrorState, Field, FormActions, FormGrid, FormSection, FormStack, Input, MediaDropzone, PageHeader, Select, Skeleton, Textarea } from '../../components/ds';
import {
  BotoesEditor,
  CorpoVariaveisEditor,
  InserirVariaveis,
  PreviewWhatsapp,
  VariavelSelect,
  filtrarBotoesParaEnvio,
  type BotaoEditorValue,
} from '../../components/template-editor';
import { chaveValidaParaTipo, contarVariaveis, definirCamposCustomizados, extrairTextosComponentes, type TemplateBotao } from '../../lib/templateVariables';
import { criarTemplate, listCamposCustomizados, type HeaderTipo, type WhatsappTemplate } from '../../api/templates';
import { uploadMedia, type MediaAsset } from '../../api/media';

import '../../pedidos-central.css';
import '../../templates.css';

// Porte de src/templates-novo.js.

function inserirTokenNoRef(
  ref: React.RefObject<HTMLInputElement | HTMLTextAreaElement>,
  valorAtual: string,
  indice: number,
  setValor: (v: string) => void,
) {
  const node = ref.current;
  const token = '{{' + indice + '}}';
  const start = node?.selectionStart ?? valorAtual.length;
  const end = node?.selectionEnd ?? valorAtual.length;
  const novoValor = valorAtual.slice(0, start) + token + valorAtual.slice(end);
  setValor(novoValor);
  setTimeout(() => {
    if (node) {
      const novaPos = start + token.length;
      node.focus();
      node.setSelectionRange(novaPos, novaPos);
    }
  }, 0);
}

function botaoUrlTipoDe(valor: string | null): 'ESTATICO' | 'DINAMICO' {
  return /\{\{1\}\}\s*$/.test((valor || '').trim()) ? 'DINAMICO' : 'ESTATICO';
}

function botoesFromTextos(botoes: TemplateBotao[]): BotaoEditorValue[] {
  return botoes.map((b) => ({
    tipo: (b.tipo as BotaoEditorValue['tipo']) || 'QUICK_REPLY',
    texto: b.texto || '',
    valor: b.tipo === 'URL' || b.tipo === 'PHONE_NUMBER' ? b.valor || '' : '',
    ...(b.tipo === 'URL' ? { urlTipo: botaoUrlTipoDe(b.valor) } : {}),
  }));
}

interface Duplicado {
  name: string;
  category?: string;
  config?: { tipo?: string };
  components?: WhatsappTemplate['components'];
}

export function TemplatesNovoPage() {
  const navigate = useNavigate();
  const [carregando, setCarregando] = useState(true);
  const [erroCarregar, setErroCarregar] = useState('');

  const [nome, setNome] = useState('');
  const [categoria, setCategoria] = useState<'UTILITY' | 'MARKETING' | 'AUTHENTICATION'>('UTILITY');
  const [tipoMsg, setTipoMsg] = useState<'pedido' | 'carrinho'>('pedido');
  const [headerTipo, setHeaderTipo] = useState<HeaderTipo>('TEXT');
  const [headerTexto, setHeaderTexto] = useState('');
  const [headerVariavel, setHeaderVariavel] = useState('');
  const [sampleMediaAsset, setSampleMediaAsset] = useState<MediaAsset | null>(null);
  const [sampleMediaErro, setSampleMediaErro] = useState<string | null>(null);
  const [sampleLocationNome, setSampleLocationNome] = useState('');
  const [sampleLocationEndereco, setSampleLocationEndereco] = useState('');
  const [sampleLocationLat, setSampleLocationLat] = useState('');
  const [sampleLocationLng, setSampleLocationLng] = useState('');
  const [corpoTexto, setCorpoTexto] = useState('');
  const [corpoVariaveis, setCorpoVariaveis] = useState<string[]>([]);
  const [footer, setFooter] = useState('');
  const [botoes, setBotoes] = useState<BotaoEditorValue[]>([]);
  const [campoAtivo, setCampoAtivo] = useState<'header' | 'corpo'>('corpo');
  const [avisoDuplicado, setAvisoDuplicado] = useState('');
  const [msg, setMsg] = useState<{ texto: string; erro: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const headerRef = useRef<HTMLInputElement>(null);
  const corpoRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listCamposCustomizados()
      .then((data) => {
        const campos = data.campos || {};
        definirCamposCustomizados(Object.keys(campos).map((chave) => ({ chave, label: campos[chave].label })));
        setCarregando(false);

        let duplicado: Duplicado | null = null;
        try {
          duplicado = JSON.parse(window.sessionStorage.getItem('ad_duplicar_template') || 'null');
        } catch {
          duplicado = null;
        }
        window.sessionStorage.removeItem('ad_duplicar_template');
        if (duplicado) {
          setAvisoDuplicado(`Duplicando "${duplicado.name}" — revise o nome e o conteúdo antes de enviar.`);
          setNome(duplicado.name + '_copia');
          if (duplicado.category === 'UTILITY' || duplicado.category === 'MARKETING' || duplicado.category === 'AUTHENTICATION') {
            setCategoria(duplicado.category);
          }
          const tipoDuplicado = duplicado.config?.tipo;
          if (tipoDuplicado === 'pedido' || tipoDuplicado === 'carrinho') setTipoMsg(tipoDuplicado);

          const textos = extrairTextosComponentes(duplicado.components);
          if (textos.header) setHeaderTexto(textos.header);
          setCorpoTexto(textos.corpo || '');
          setFooter(textos.footer || '');
          setBotoes(botoesFromTextos(textos.botoes || []));
        }
      })
      .catch((err: Error) => setErroCarregar(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Descarta seleção de variável do cabeçalho que não é mais válida pro novo tipo.
  useEffect(() => {
    if (headerVariavel && !chaveValidaParaTipo(headerVariavel, tipoMsg)) setHeaderVariavel('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipoMsg]);

  function inserirVariavel(chave: string) {
    if (campoAtivo === 'header') {
      if (contarVariaveis(headerTexto) >= 1) {
        setMsg({ texto: 'O cabeçalho só pode ter uma variável.', erro: true });
        return;
      }
      inserirTokenNoRef(headerRef, headerTexto, 1, setHeaderTexto);
      setHeaderVariavel(chave);
    } else {
      const proximoIndice = contarVariaveis(corpoTexto) + 1;
      inserirTokenNoRef(corpoRef, corpoTexto, proximoIndice, setCorpoTexto);
      setCorpoVariaveis((prev) => {
        const next = prev.slice(0, proximoIndice);
        while (next.length < proximoIndice) next.push('');
        next[proximoIndice - 1] = chave;
        return next;
      });
    }
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    setMsg(null);

    if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerTipo) && !sampleMediaAsset) {
      setMsg({ texto: 'Envie um arquivo de amostra pro cabeçalho antes de continuar.', erro: true });
      return;
    }
    if (headerTipo === 'LOCATION' && (!sampleLocationNome.trim() || !sampleLocationLat.trim() || !sampleLocationLng.trim())) {
      setMsg({ texto: 'Preencha nome, latitude e longitude da amostra de localização.', erro: true });
      return;
    }

    setEnviando(true);
    criarTemplate({
      nome: nome.trim(),
      categoria,
      tipo: tipoMsg,
      headerTexto: headerTipo === 'TEXT' ? headerTexto.trim() || null : null,
      headerVariavel: headerTipo === 'TEXT' ? headerVariavel || null : null,
      corpo: corpoTexto.trim(),
      corpoVariaveis,
      footer: footer.trim() || null,
      botoes: filtrarBotoesParaEnvio(botoes),
      headerTipo,
      sampleMediaAssetId: sampleMediaAsset?.id ?? null,
      sampleLocation:
        headerTipo === 'LOCATION'
          ? {
              nome: sampleLocationNome.trim(),
              endereco: sampleLocationEndereco.trim(),
              latitude: Number(sampleLocationLat),
              longitude: Number(sampleLocationLng),
            }
          : null,
    })
      .then(() => navigate('/admin/templates'))
      .catch((err: Error) => {
        setMsg({ texto: err.message, erro: true });
        setEnviando(false);
      });
  }

  const mapaAcceptDropzone = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' } as const;

  if (erroCarregar) return <ErrorState description={erroCarregar} />;
  if (carregando) return <Skeleton rows={6} />;

  const numHeaderVars = contarVariaveis(headerTexto);

  return (
    <>
      <PageHeader title="Novo template" back={{ to: '/admin/templates', label: 'Voltar pra lista' }} />

      <div className="ad-template-novo-layout">
        <Card className="ad-template-novo-layout__form">
          <FormStack onSubmit={submit}>
            <p className="ds-note">O vínculo com evento e as variáveis usadas no envio são configurados depois em Automações — aqui é só a criação/envio pra aprovação da Meta.</p>
            {avisoDuplicado && <p className="ds-note">{avisoDuplicado}</p>}

            <FormSection title="Identificação">
            <Field label='Nome (só minúsculas, números e "_")' required>
              <Input type="text" placeholder="ex: pagamento_aprovado" pattern="[a-z0-9_]+" required value={nome} onChange={(e) => setNome(e.target.value)} />
            </Field>

            <FormGrid>
            <Field label="Categoria">
              <Select value={categoria} onChange={(e) => setCategoria(e.target.value as typeof categoria)}>
                <option value="UTILITY">Utilidade (atualização de pedido — mais comum aqui)</option>
                <option value="MARKETING">Marketing</option>
                <option value="AUTHENTICATION">Autenticação</option>
              </Select>
            </Field>

            <Field label="Tipo de mensagem" hint="Só aparecem os dados que existem de verdade nesse tipo de evento.">
              <Select value={tipoMsg} onChange={(e) => setTipoMsg(e.target.value as typeof tipoMsg)}>
                <option value="pedido">Pedido (confirmação, status, rastreio…)</option>
                <option value="carrinho">Carrinho abandonado</option>
              </Select>
            </Field>
            </FormGrid>
            </FormSection>

            <FormSection title="Cabeçalho">
            <Field label="Amostra de mídia" hint="Opcional — usada só na aprovação do template pela Meta, não é a mídia enviada pro cliente (isso é configurado em Campanhas).">
              <Select
                value={headerTipo}
                onChange={(e) => {
                  const novoTipo = e.target.value as HeaderTipo;
                  setHeaderTipo(novoTipo);
                  if (novoTipo !== 'TEXT') {
                    setHeaderTexto('');
                    setHeaderVariavel('');
                  }
                }}
              >
                <option value="TEXT">Nenhum (ou texto)</option>
                <option value="IMAGE">Imagem</option>
                <option value="VIDEO">Vídeo</option>
                <option value="DOCUMENT">Documento</option>
                <option value="LOCATION">Localização</option>
              </Select>
            </Field>

            {headerTipo === 'TEXT' && (
              <>
                <Field label="Cabeçalho (opcional)">
                  <Input
                    ref={headerRef}
                    type="text"
                    placeholder="ex: Pedido confirmado"
                    maxLength={60}
                    value={headerTexto}
                    onFocus={() => setCampoAtivo('header')}
                    onChange={(e) => setHeaderTexto(e.target.value)}
                  />
                </Field>
                {numHeaderVars > 0 && (
                  <Field label="Variável do cabeçalho">
                    <VariavelSelect tipo={tipoMsg} value={headerVariavel} onChange={(e) => setHeaderVariavel(e.target.value)} />
                  </Field>
                )}
              </>
            )}

            {(headerTipo === 'IMAGE' || headerTipo === 'VIDEO' || headerTipo === 'DOCUMENT') && (
              <Field label="Arquivo de amostra">
                <MediaDropzone
                  accept={mapaAcceptDropzone[headerTipo]}
                  erro={sampleMediaErro}
                  value={sampleMediaAsset ? { filename: sampleMediaAsset.filename, sizeBytes: sampleMediaAsset.sizeBytes, previewUrl: sampleMediaAsset.previewUrl } : null}
                  onUpload={async (file) => {
                    setSampleMediaErro(null);
                    const resultado = await uploadMedia(file);
                    if (resultado.avisoMeta) {
                      setSampleMediaErro(resultado.avisoMeta);
                    }
                    setSampleMediaAsset(resultado.asset);
                  }}
                  onRemove={() => {
                    setSampleMediaAsset(null);
                    setSampleMediaErro(null);
                  }}
                />
              </Field>
            )}

            {headerTipo === 'LOCATION' && (
              <>
                <Field label="Nome/local da amostra">
                  <Input type="text" placeholder="ex: Loja Orgulho Regional" value={sampleLocationNome} onChange={(e) => setSampleLocationNome(e.target.value)} />
                </Field>
                <Field label="Endereço da amostra (opcional)">
                  <Input type="text" placeholder="ex: Rua Exemplo, 123" value={sampleLocationEndereco} onChange={(e) => setSampleLocationEndereco(e.target.value)} />
                </Field>
                <FormGrid min={160}>
                  <Field label="Latitude">
                    <Input type="number" step="any" placeholder="-27.5954" value={sampleLocationLat} onChange={(e) => setSampleLocationLat(e.target.value)} />
                  </Field>
                  <Field label="Longitude">
                    <Input type="number" step="any" placeholder="-48.5480" value={sampleLocationLng} onChange={(e) => setSampleLocationLng(e.target.value)} />
                  </Field>
                </FormGrid>
              </>
            )}
            </FormSection>

            <FormSection title="Conteúdo">
            <Field
              label="Corpo da mensagem"
              required
              hint='No máximo 1 linha em branco entre parágrafos, até 10 emojis, e não pode ser só variável sem texto ao redor (exigências da Meta).'
            >
              <Textarea
                ref={corpoRef}
                placeholder="Escreva a mensagem e use os botões abaixo pra inserir os dados dinâmicos."
                required
                value={corpoTexto}
                onFocus={() => setCampoAtivo('corpo')}
                onChange={(e) => setCorpoTexto(e.target.value)}
              />
            </Field>
            <CorpoVariaveisEditor count={contarVariaveis(corpoTexto)} tipo={tipoMsg} value={corpoVariaveis} onChange={setCorpoVariaveis} />

            <InserirVariaveis tipo={tipoMsg} aoClicar={inserirVariavel} />

            <Field label="Rodapé (opcional, sem variável)" hint="Sem emoji e sem quebra de linha — a Meta rejeita.">
              <Input type="text" placeholder="ex: Orgulho Regional" maxLength={60} value={footer} onChange={(e) => setFooter(e.target.value)} />
            </Field>
            </FormSection>

            <FormSection>
            <Field
              label="Botões (opcional, até 3)"
              hint='Link dinâmico precisa de um endereço completo antes do {{1}} (ex: https://seusite.com/{{1}}) — a Meta rejeita se o campo de URL for só "{{1}}" sozinho.'
            >
              <BotoesEditor tipo={tipoMsg} value={botoes} onChange={setBotoes} />
            </Field>
            </FormSection>

            {msg && (
              <div className={msg.erro ? 'ds-form-error' : 'ds-form-note'} role={msg.erro ? 'alert' : 'status'}>
                {msg.texto}
              </div>
            )}
            <FormActions>
              <Button type="submit" disabled={enviando}>
                {enviando ? 'Enviando…' : 'Enviar pra aprovação da Meta'}
              </Button>
            </FormActions>
          </FormStack>
        </Card>

        <Card className="ad-template-novo-layout__preview">
          <PreviewWhatsapp
            headerTexto={headerTipo === 'TEXT' ? headerTexto : null}
            headerChaves={[headerVariavel]}
            headerMediaTipo={headerTipo === 'TEXT' ? null : headerTipo}
            headerMediaPreviewUrl={sampleMediaAsset?.previewUrl ?? null}
            corpoTexto={corpoTexto}
            corpoChaves={corpoVariaveis}
            footer={footer}
            botoes={botoes}
          />
        </Card>
      </div>
    </>
  );
}
