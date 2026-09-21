import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNomeDaStore } from '../../auth/AuthContext';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, ErrorState, Field, FormActions, FormStack, Icon, Input, PageHeader, Select, Skeleton } from '../../components/ds';
import { eventoLabel } from '../../lib/eventLabels';
import { InserirVariaveis } from '../../components/template-editor';
import { PreviewMensagemWeb } from '../../components/PreviewMensagemWeb';
import { definirCamposCustomizados, gruposParaMensagemWeb, useGruposVariaveis } from '../../lib/templateVariables';
import { variaveisInvalidas } from '../../lib/whatsappFormat';
import { getCamposCustomizados } from '../../api/campos';
import { adminStores } from '../../state/adminStores';
import { criarMensagemWeb, obterMensagemWeb, salvarMensagemWeb, type MensagemWeb, type MensagemWebTipo } from '../../api/whatsappWeb';
import { TIPO_MENSAGEM_LABEL } from './MensagensWebPage';

import '../../templates.css';
import '../../whatsapp-web.css';

const LIMITE_CARACTERES = 4096;
const MAX_VERSOES = 5;

const TIPO_DICA: Record<MensagemWebTipo, string> = {
  comum: 'Pode ser usada em qualquer evento — só com dados do cliente e da loja.',
  pedido: 'Eventos de pedido e lembrete de Pix (status, rastreio, link de pagamento…).',
  carrinho: 'Eventos de carrinho abandonado (itens do carrinho…).',
  campanha: 'Campanhas pra uma audiência (primeiro nome, total gasto, última compra…). Não vai pra Automações.',
};

// Marcadores de formatação do WhatsApp — envolvem a seleção (ou inserem um par vazio no cursor).
const FORMATOS = [
  { marcador: '*', rotulo: 'N', titulo: 'Negrito (*texto*)', className: 'wa-editor__fmt--negrito' },
  { marcador: '_', rotulo: 'I', titulo: 'Itálico (_texto_)', className: 'wa-editor__fmt--italico' },
  { marcador: '~', rotulo: 'S', titulo: 'Riscado (~texto~)', className: 'wa-editor__fmt--riscado' },
  { marcador: '```', rotulo: '</>', titulo: 'Monoespaçado (```texto```)', className: 'wa-editor__fmt--mono' },
];

export function MensagemWebEditorPage() {
  const nomeStore = useNomeDaStore();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const edicao = !!id;
  const corpoRef = useRef<HTMLTextAreaElement>(null);
  useGruposVariaveis();

  const [original, setOriginal] = useState<MensagemWeb | null>(null);
  const [carregando, setCarregando] = useState(edicao);
  const [erroCarga, setErroCarga] = useState('');
  const [nome, setNome] = useState('');
  const [tipo, setTipo] = useState<MensagemWebTipo>('pedido');
  // versoes[0] é o texto principal (corpo); as demais são as variações sorteadas a cada envio.
  const [versoes, setVersoes] = useState<string[]>(['']);
  const [ativa, setAtiva] = useState(0);
  const corpo = versoes[ativa] ?? '';
  const setCorpo = (texto: string) => setVersoes((atual) => atual.map((v, i) => (i === ativa ? texto : v)));
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<{ erro: boolean; texto: string } | null>(null);

  useEffect(() => {
    getCamposCustomizados()
      .then((res) => definirCamposCustomizados(Object.keys(res.campos || {}).map((chave) => ({ chave, label: res.campos[chave].label }))))
      .catch(() => { /* sem campos personalizados, segue só com as variáveis padrão */ });
  }, []);

  useEffect(() => {
    if (!id) return;
    obterMensagemWeb(id)
      .then(({ mensagem }) => {
        setOriginal(mensagem);
        setNome(mensagem.nome);
        setTipo(mensagem.tipo);
        setVersoes([mensagem.corpo, ...(mensagem.variacoes || [])]);
        setAtiva(0);
      })
      .catch((err: Error) => setErroCarga(err.message))
      .finally(() => setCarregando(false));
  }, [id]);

  const grupos = gruposParaMensagemWeb(tipo);
  const permitidas = grupos.flatMap((g) => g.itens.map((v) => v.chave));
  const invalidas = [...new Set(versoes.flatMap((v) => variaveisInvalidas(v, permitidas)))];
  const versaoVazia = versoes.findIndex((v) => !v.trim());

  function adicionarVersao() {
    if (versoes.length >= MAX_VERSOES) return;
    setVersoes((atual) => [...atual, '']);
    setAtiva(versoes.length);
    setTimeout(() => corpoRef.current?.focus(), 0);
  }

  function removerVersao(indice: number) {
    if (versoes.length <= 1) return;
    setVersoes((atual) => atual.filter((_, i) => i !== indice));
    setAtiva((atual) => (atual >= indice ? Math.max(0, atual - 1) : atual));
  }

  function substituirSelecao(transformar: (selecionado: string) => { texto: string; cursor: number }) {
    const node = corpoRef.current;
    const inicio = node?.selectionStart ?? corpo.length;
    const fim = node?.selectionEnd ?? corpo.length;
    const { texto, cursor } = transformar(corpo.slice(inicio, fim));
    setCorpo(corpo.slice(0, inicio) + texto + corpo.slice(fim));
    setTimeout(() => {
      if (!node) return;
      node.focus();
      node.setSelectionRange(inicio + cursor, inicio + cursor);
    }, 0);
  }

  function inserirVariavel(chave: string) {
    const token = `{{${chave}}}`;
    substituirSelecao(() => ({ texto: token, cursor: token.length }));
  }

  function aplicarFormato(marcador: string) {
    substituirSelecao((selecionado) =>
      selecionado
        ? { texto: marcador + selecionado + marcador, cursor: selecionado.length + marcador.length * 2 }
        : { texto: marcador + marcador, cursor: marcador.length },
    );
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    setMsg(null);
    if (invalidas.length) {
      setMsg({ erro: true, texto: 'Remova as variáveis que não existem nesse tipo de mensagem antes de salvar.' });
      return;
    }
    if (versaoVazia !== -1) {
      setAtiva(versaoVazia);
      setMsg({ erro: true, texto: `A versão ${versaoVazia + 1} está vazia — escreva o texto ou remova a versão.` });
      return;
    }
    setSalvando(true);
    const [principal, ...variacoes] = versoes;
    const dados = { nome: nome.trim(), tipo, corpo: principal, variacoes };
    const operacao = id ? salvarMensagemWeb(id, dados) : criarMensagemWeb(dados);
    operacao
      .then(({ mensagem }) => {
        if (!id) {
          navigate(`/admin/mensagens/${mensagem.id}`, { replace: true });
          return;
        }
        setOriginal(mensagem);
        setMsg({ erro: false, texto: 'Mensagem salva.' });
      })
      .catch((err: Error) => setMsg({ erro: true, texto: err.message }))
      .finally(() => setSalvando(false));
  }

  if (carregando) return <Skeleton rows={6} />;
  if (erroCarga) return <ErrorState description={erroCarga} />;

  return (
    <>
      <PageHeader title={edicao ? 'Editar mensagem' : 'Nova mensagem'} back={{ to: '/admin/mensagens', label: 'Voltar pra lista' }} />

      <div className="ad-template-novo-layout">
        <Card className="ad-template-novo-layout__form">
          <FormStack onSubmit={submit}>
          <p className="ds-note">
            No WhatsApp Web não existe cabeçalho, rodapé nem botão: tudo vai no texto. Links podem ir direto no corpo (o WhatsApp deixa clicável).
          </p>
          {original && original.eventos.length > 0 && (
            <p className="ds-note">
              Em uso em: {original.eventos.map((v) => `${adminStores.nameOr(v.loja, nomeStore)}: ${eventoLabel(v.evento)}`).join(', ')}. Alterações valem pros próximos envios.
            </p>
          )}

            <Field label="Nome" required hint="Só pra identificar no painel, o cliente não vê.">
              <Input type="text" required maxLength={80} placeholder="ex: Pedido enviado" value={nome} onChange={(e) => setNome(e.target.value)} />
            </Field>

            <Field label="Tipo de mensagem" hint={TIPO_DICA[tipo]}>
              <Select value={tipo} onChange={(e) => setTipo(e.target.value as MensagemWebTipo)}>
                {(Object.keys(TIPO_MENSAGEM_LABEL) as MensagemWebTipo[]).map((t) => (
                  <option key={t} value={t}>
                    {TIPO_MENSAGEM_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Texto da mensagem"
              required
              htmlFor="mensagem-web-corpo"
              hint={`Até ${MAX_VERSOES} versões. A cada envio o sistema sorteia uma — textos diferentes pra cada contato reduzem o risco de o WhatsApp tratar como spam, principalmente em campanhas.`}
            >
              <div className="wa-versoes" role="group" aria-label="Versões da mensagem">
                {versoes.map((v, i) => (
                  <span key={i} className={'wa-versoes__aba' + (i === ativa ? ' wa-versoes__aba--ativa' : '') + (!v.trim() ? ' wa-versoes__aba--vazia' : '')}>
                    <button type="button" aria-pressed={i === ativa} onClick={() => setAtiva(i)}>
                      Versão {i + 1}
                    </button>
                    {versoes.length > 1 && (
                      <button type="button" className="wa-versoes__remover" aria-label={`Remover versão ${i + 1}`} title="Remover versão" onClick={() => removerVersao(i)}>
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {versoes.length < MAX_VERSOES && (
                  <button type="button" className="wa-versoes__adicionar" onClick={adicionarVersao}>
                    Adicionar versão
                  </button>
                )}
              </div>
              <div className="wa-editor__toolbar" role="toolbar" aria-label="Formatação">
                {FORMATOS.map((f) => (
                  <button key={f.marcador} type="button" className={`wa-editor__fmt ${f.className}`} title={f.titulo} aria-label={f.titulo} onClick={() => aplicarFormato(f.marcador)}>
                    {f.rotulo}
                  </button>
                ))}
                <span className={'wa-editor__contador' + (corpo.length > LIMITE_CARACTERES ? ' wa-editor__contador--excedido' : '')}>
                  {corpo.length}/{LIMITE_CARACTERES}
                </span>
              </div>
              <textarea
                id="mensagem-web-corpo"
                ref={corpoRef}
                className="ds-textarea wa-editor__textarea"
                required
                maxLength={LIMITE_CARACTERES}
                placeholder={'Olá {{cliente.nome}}! Seu pedido *{{pedido.numero}}* já saiu para entrega.\n\nAcompanhe: {{pedido.rastreio}}'}
                value={corpo}
                onChange={(e) => setCorpo(e.target.value)}
              />
            </Field>
            {invalidas.length > 0 && (
              <p className="ds-form-error">
                Variável que não existe em mensagens do tipo "{TIPO_MENSAGEM_LABEL[tipo]}": {invalidas.map((v) => `{{${v}}}`).join(', ')}
              </p>
            )}

            <InserirVariaveis tipo={tipo} grupos={grupos} aoClicar={inserirVariavel} dica="Clique num dado pra inserir no texto, na posição do cursor." />

            {msg && (
              <div className={msg.erro ? 'ds-form-error' : 'ds-form-note'} role={msg.erro ? 'alert' : 'status'}>
                {msg.texto}
              </div>
            )}
            <FormActions>
              <Button type="submit" disabled={salvando}>
                {salvando ? 'Salvando…' : edicao ? 'Salvar alterações' : 'Criar mensagem'}
              </Button>
            </FormActions>
          </FormStack>
        </Card>

        <Card className="ad-template-novo-layout__preview">
          <PreviewMensagemWeb corpo={corpo} dica={versoes.length > 1 ? `Prévia da versão ${ativa + 1} de ${versoes.length} (com dados de exemplo).` : undefined} />
        </Card>
      </div>
    </>
  );
}
