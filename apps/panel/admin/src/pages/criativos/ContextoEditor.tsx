import { useMemo, useState, type FormEvent } from 'react';
import {
  Button,
  Callout,
  Field,
  FormActions,
  FormGrid,
  FormSection,
  FormStack,
  Input,
  Select,
  Switch,
  Textarea,
} from '../../components/ds';
import { toast } from '../../lib/toast';
import { plural } from '../../lib/format';
import { createProfile, updateProfile } from '../../api/criativos';
import { ChatGptModal } from './ChatGptModal';
import { LIMITE_DESCRICAO, LIMITE_NOME, listaParaTexto, textoParaLista } from './kitTemplate';
import {
  SECOES_CONTEXTO,
  STATUS_CONTEXTO,
  TIPOS_CONTEXTO,
  lerRespostaDoContexto,
  montarPromptContexto,
  tiposValidos,
} from './contextoTemplate';

// Formulário guiado do perfil de contexto, no mesmo molde do KitEditor: atalho "Preencher com
// ChatGPT" e JSON completo como modo avançado. O status fica fora do JSON porque o servidor o recebe
// à parte; o que vem do ChatGPT sempre volta como rascunho, para uma pessoa revisar e aprovar.

interface ContextoEditorProps {
  inicial: Record<string, unknown> | null;
  statusInicial: string;
  editando: { id: string; version: number } | null;
  onSalvo: () => void;
  onDescartar: () => void;
}

interface EstadoForm {
  nome: string;
  tipo: string;
  resumo: string;
  listas: Record<string, string>;
  // Campos que o formulário não edita (fontes, confiança, metadata do assunto): preservados como
  // vieram e editáveis só no modo JSON.
  extra: Record<string, unknown>;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function estadoDeDados(dados: Record<string, unknown>): EstadoForm {
  const extra = { ...dados };
  const tirar = (k: string) => { const v = extra[k]; delete extra[k]; return v; };
  const listas: Record<string, string> = {};
  for (const secao of SECOES_CONTEXTO) {
    for (const campo of secao.campos) listas[campo.key] = listaParaTexto(tirar(campo.key));
  }
  const subject = tirar('subject');
  const assunto = ehObjeto(subject) ? { ...subject } : {};
  const nome = assunto.name;
  delete assunto.name;
  if (Object.keys(assunto).length) extra.subject = assunto;
  const tipo = tirar('contextType');
  const resumo = tirar('summary');
  return {
    nome: typeof nome === 'string' ? nome : '',
    tipo: typeof tipo === 'string' && tiposValidos.has(tipo) ? tipo : 'custom',
    resumo: typeof resumo === 'string' ? resumo : '',
    listas,
    extra,
  };
}

function dadosDoEstado(form: EstadoForm): Record<string, unknown> {
  const { subject: assuntoExtra, ...resto } = form.extra;
  const dados: Record<string, unknown> = {
    ...resto,
    contextType: form.tipo,
    subject: { ...(ehObjeto(assuntoExtra) ? assuntoExtra : {}), name: form.nome.trim() },
  };
  if (form.resumo.trim()) dados.summary = form.resumo.trim();
  for (const [key, texto] of Object.entries(form.listas)) {
    const lista = textoParaLista(texto);
    if (lista.length) dados[key] = lista;
  }
  return dados;
}

export function ContextoEditor({ inicial, statusInicial, editando, onSalvo, onDescartar }: ContextoEditorProps) {
  const [form, setForm] = useState<EstadoForm>(() => estadoDeDados(inicial ?? {}));
  const [status, setStatus] = useState(statusInicial);
  const [modoJson, setModoJson] = useState(false);
  const [jsonTexto, setJsonTexto] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [chatAberto, setChatAberto] = useState(false);
  const [ignorados, setIgnorados] = useState<string[]>([]);
  const prompt = useMemo(montarPromptContexto, []);

  const setLista = (key: string, texto: string) => setForm((f) => ({ ...f, listas: { ...f.listas, [key]: texto } }));

  function alternarModoJson(ligar: boolean) {
    setErro('');
    if (ligar) {
      setJsonTexto(JSON.stringify(dadosDoEstado(form), null, 2));
      setModoJson(true);
      return;
    }
    try {
      const dados = JSON.parse(jsonTexto);
      if (!ehObjeto(dados)) throw new Error();
      setForm(estadoDeDados(dados));
      setModoJson(false);
    } catch {
      setErro('JSON inválido: corrija vírgulas e aspas antes de voltar ao formulário.');
    }
  }

  // Lança o erro de leitura para o ChatGptModal mostrar.
  function aplicarResposta(resposta: string) {
    const leitura = lerRespostaDoContexto(resposta);
    // O que veio do ChatGPT substitui os campos respondidos; o resto do que já estava no formulário fica.
    setForm((f) => {
      const atual = dadosDoEstado(f);
      const assunto = ehObjeto(leitura.data.subject) ? { ...(atual.subject as Record<string, unknown>), ...leitura.data.subject } : atual.subject;
      return estadoDeDados({ ...atual, ...leitura.data, subject: assunto });
    });
    setIgnorados(leitura.ignorados);
    setModoJson(false);
    // Sugestão de IA nunca entra aprovada: só perfil aprovado chega ao prompt de geração.
    setStatus('draft');
    toast('Formulário preenchido como rascunho. Revise e aprove antes de usar.', 'sucesso');
  }

  function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErro('');
    let dados: Record<string, unknown>;
    if (modoJson) {
      try {
        dados = JSON.parse(jsonTexto);
      } catch {
        setErro('JSON inválido: confira vírgulas e aspas.');
        return;
      }
    } else {
      dados = dadosDoEstado(form);
    }
    const assunto = ehObjeto(dados.subject) ? dados.subject : {};
    if (!String(assunto.name ?? '').trim()) {
      setErro('Informe o nome do contexto.');
      return;
    }
    // Mesma regra do core: perfil aprovado sem cena falha na geração (profile_without_scenes).
    if (status === 'approved' && !(Array.isArray(dados.sceneContexts) && dados.sceneContexts.length > 0)) {
      setErro('Para aprovar, informe ao menos uma cena.');
      return;
    }
    setSalvando(true);
    const acao = editando ? updateProfile('context-profiles', editando.id, dados, status) : createProfile('context-profiles', dados, status);
    acao
      .then(() => { toast(editando ? 'Nova versão salva.' : 'Cadastro criado.', 'sucesso'); onSalvo(); })
      .catch((e: Error) => setErro(e.message))
      .finally(() => setSalvando(false));
  }

  return (
    <FormStack wide onSubmit={salvar}>
      <Callout
        tone="info"
        title="Não sabe o que escrever?"
        action={<Button size="sm" variant="secondary" onClick={() => setChatAberto(true)}>Preencher com ChatGPT</Button>}
      >
        Copie um prompt pronto, responda às perguntas sobre o contexto no ChatGPT e cole a resposta aqui. O formulário é preenchido como rascunho para você revisar.
      </Callout>

      {ignorados.length > 0 && (
        <Callout tone="warning" title="Parte da resposta foi ignorada">
          {plural(ignorados.length, 'campo não existe', 'campos não existem')} no contexto: {ignorados.join(', ')}.
        </Callout>
      )}

      <Field label="Status" hint="Só perfis aprovados aparecem na geração.">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_CONTEXTO.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </Field>

      <Switch
        checked={modoJson}
        onChange={alternarModoJson}
        label="Editar como JSON"
        description="Modo avançado: mostra o perfil inteiro, incluindo fontes, confiança e metadados do assunto."
      />

      {modoJson ? (
        <Field label="Contexto (JSON)" hint="Identificador, status, versão e schema são definidos pelo servidor.">
          <Textarea rows={18} spellCheck={false} value={jsonTexto} onChange={(e) => setJsonTexto(e.target.value)} />
        </Field>
      ) : (
        <>
          <FormSection title="Identificação">
            <FormGrid>
              <Field label="Nome do contexto" required hint="Ex.: Serra gaúcha no inverno; Torcida do interior.">
                <Input maxLength={LIMITE_NOME} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
              </Field>
              <Field label="Tipo de contexto">
                <Select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value })}>
                  {TIPOS_CONTEXTO.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </Field>
            </FormGrid>
            <Field label="Resumo" optional hint="1 a 3 frases: que lugar, tema ou grupo é esse e o que o torna reconhecível.">
              <Textarea rows={3} maxLength={LIMITE_DESCRICAO} value={form.resumo} onChange={(e) => setForm({ ...form, resumo: e.target.value })} />
            </Field>
          </FormSection>

          {SECOES_CONTEXTO.map((secao) => (
            <FormSection key={secao.title} title={secao.title} description={secao.description}>
              <FormGrid min={280}>
                {secao.campos.map((campo) => (
                  <Field key={campo.key} label={campo.label} optional hint={campo.hint}>
                    <Textarea rows={4} value={form.listas[campo.key] ?? ''} onChange={(e) => setLista(campo.key, e.target.value)} />
                  </Field>
                ))}
              </FormGrid>
            </FormSection>
          ))}
        </>
      )}

      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
      <FormActions start={<Button variant="ghost" onClick={onDescartar}>Descartar</Button>}>
        <Button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : editando ? `Salvar v${editando.version + 1}` : 'Salvar'}</Button>
      </FormActions>

      <ChatGptModal open={chatAberto} onClose={() => setChatAberto(false)} prompt={prompt} onAplicar={aplicarResposta} assunto="o contexto" />
    </FormStack>
  );
}
