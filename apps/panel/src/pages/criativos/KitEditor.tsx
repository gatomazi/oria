import { useMemo, useState, type FormEvent } from 'react';
import {
  Button,
  Callout,
  Checkbox,
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
import { createProfile, updateProfile, type Catalog } from '../../api/criativos';
import { ChatGptModal } from './ChatGptModal';
import {
  LIMITE_DESCRICAO,
  LIMITE_NOME,
  PROVEDORES_CONTEXTO,
  campoDeAngulos,
  lerRespostaDoKit,
  listaParaTexto,
  montarPromptChatGpt,
  secoesDoKit,
  textoParaLista,
  type KitKind,
} from './kitTemplate';

// Formulário guiado do Brand Kit / Niche Kit, com atalho "Preencher com ChatGPT" (o lojista leva um
// prompt pronto ao ChatGPT e cola a resposta) e o JSON completo como modo avançado. O servidor
// continua validando tudo pelo contrato do core no salvar.

interface KitEditorProps {
  kind: KitKind;
  catalog: Catalog | null;
  inicial: Record<string, unknown> | null;
  editando: { id: string; version: number } | null;
  onSalvo: () => void;
  onDescartar: () => void;
}

interface EstadoForm {
  nome: string;
  descricao: string;
  listas: Record<string, string>;
  angulos: string[];
  nichoPadrao: string;
  contextoPadrao: string;
  vestuario: boolean;
  // Campos que o formulário não edita (rótulos de ângulo, regras por estratégia, personas sugeridas):
  // preservados como vieram e editáveis só no modo JSON.
  extra: Record<string, unknown>;
}

function estadoDeDados(kind: KitKind, dados: Record<string, unknown>): EstadoForm {
  const extra = { ...dados };
  const tirar = (k: string) => { const v = extra[k]; delete extra[k]; return v; };
  const listas: Record<string, string> = {};
  for (const secao of secoesDoKit(kind)) {
    for (const campo of secao.campos) listas[campo.key] = listaParaTexto(tirar(campo.key));
  }
  const angulos = tirar(campoDeAngulos(kind));
  const nome = tirar('name');
  const descricao = tirar('description');
  const nichoPadrao = tirar('defaultNicheKitId');
  const contextoPadrao = tirar('defaultContextProvider');
  const vestuario = tirar('supportsApparelAngles');
  return {
    nome: typeof nome === 'string' ? nome : '',
    descricao: typeof descricao === 'string' ? descricao : '',
    listas,
    angulos: Array.isArray(angulos) ? angulos.filter((a): a is string => typeof a === 'string') : [],
    nichoPadrao: typeof nichoPadrao === 'string' ? nichoPadrao : '',
    contextoPadrao: typeof contextoPadrao === 'string' ? contextoPadrao : '',
    vestuario: vestuario === true,
    extra,
  };
}

function dadosDoEstado(kind: KitKind, form: EstadoForm): Record<string, unknown> {
  const dados: Record<string, unknown> = { ...form.extra, name: form.nome.trim() };
  if (kind === 'brand-kits' && form.descricao.trim()) dados.description = form.descricao.trim();
  for (const [key, texto] of Object.entries(form.listas)) {
    const lista = textoParaLista(texto);
    if (lista.length) dados[key] = lista;
  }
  if (form.angulos.length) dados[campoDeAngulos(kind)] = form.angulos;
  if (kind === 'brand-kits') {
    if (form.nichoPadrao) dados.defaultNicheKitId = form.nichoPadrao;
    if (form.contextoPadrao) dados.defaultContextProvider = form.contextoPadrao;
  } else {
    dados.supportsApparelAngles = form.vestuario;
  }
  return dados;
}

export function KitEditor({ kind, catalog, inicial, editando, onSalvo, onDescartar }: KitEditorProps) {
  const marca = kind === 'brand-kits';
  const [form, setForm] = useState<EstadoForm>(() => estadoDeDados(kind, inicial ?? {}));
  const [modoJson, setModoJson] = useState(false);
  const [jsonTexto, setJsonTexto] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [chatAberto, setChatAberto] = useState(false);
  const [ignorados, setIgnorados] = useState<string[]>([]);

  const angles = catalog?.catalog.angles ?? [];
  const nichosEmbutidos = useMemo(() => (catalog?.catalog.builtin_kits.niche ?? []).map((k) => ({ id: String(k.id), name: k.name })), [catalog]);
  const embutidos = (marca ? catalog?.catalog.builtin_kits.brand : catalog?.catalog.builtin_kits.niche) ?? [];
  const prompt = useMemo(() => montarPromptChatGpt(kind, angles, nichosEmbutidos), [kind, angles, nichosEmbutidos]);

  const setLista = (key: string, texto: string) => setForm((f) => ({ ...f, listas: { ...f.listas, [key]: texto } }));

  function alternarModoJson(ligar: boolean) {
    setErro('');
    if (ligar) {
      setJsonTexto(JSON.stringify(dadosDoEstado(kind, form), null, 2));
      setModoJson(true);
      return;
    }
    try {
      const dados = JSON.parse(jsonTexto);
      if (!dados || typeof dados !== 'object' || Array.isArray(dados)) throw new Error();
      setForm(estadoDeDados(kind, dados));
      setModoJson(false);
    } catch {
      setErro('JSON inválido: corrija vírgulas e aspas antes de voltar ao formulário.');
    }
  }

  function partirDeEmbutido(id: string) {
    const kit = embutidos.find((k) => k.id === id);
    if (!kit) return;
    const { id: _id, version: _v, schemaVersion: _s, ...resto } = kit as Record<string, unknown>;
    setForm(estadoDeDados(kind, resto));
    setModoJson(false);
    setIgnorados([]);
  }

  // Lança o erro de leitura para o ChatGptModal mostrar.
  function aplicarResposta(resposta: string) {
    const leitura = lerRespostaDoKit(kind, resposta, angles, nichosEmbutidos);
    // O que veio do ChatGPT substitui os campos respondidos; o resto do que já estava no formulário fica.
    setForm((f) => estadoDeDados(kind, { ...dadosDoEstado(kind, f), ...leitura.data }));
    setIgnorados(leitura.ignorados);
    setModoJson(false);
    toast('Formulário preenchido. Revise antes de salvar.', 'sucesso');
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
      dados = dadosDoEstado(kind, form);
    }
    if (!String(dados.name ?? '').trim()) {
      setErro(marca ? 'Informe o nome da marca.' : 'Informe o nome do nicho.');
      return;
    }
    setSalvando(true);
    const acao = editando ? updateProfile(kind, editando.id, dados) : createProfile(kind, dados);
    acao
      .then(() => { toast(editando ? 'Nova versão salva.' : 'Cadastro criado.', 'sucesso'); onSalvo(); })
      .catch((e: Error) => setErro(e.message))
      .finally(() => setSalvando(false));
  }

  const campoAngulos = campoDeAngulos(kind);
  const alternarAngulo = (id: string) =>
    setForm((f) => ({ ...f, angulos: f.angulos.includes(id) ? f.angulos.filter((a) => a !== id) : [...f.angulos, id] }));

  return (
    <FormStack wide onSubmit={salvar}>
      <Callout
        tone="info"
        title="Não sabe o que escrever?"
        action={<Button size="sm" variant="secondary" disabled={!catalog} onClick={() => setChatAberto(true)}>Preencher com ChatGPT</Button>}
      >
        Copie um prompt pronto, responda às perguntas sobre sua loja no ChatGPT e cole a resposta aqui. O formulário é preenchido para você revisar.
      </Callout>

      {!editando && embutidos.length > 0 && (
        <Field label="Ou partir de um kit pronto" optional hint="Copia um kit de exemplo para você adaptar.">
          <Select defaultValue="" onChange={(e) => partirDeEmbutido(e.target.value)}>
            <option value="">Escolha…</option>
            {embutidos.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </Select>
        </Field>
      )}

      {ignorados.length > 0 && (
        <Callout tone="warning" title="Parte da resposta foi ignorada">
          {plural(ignorados.length, 'campo não existe', 'campos não existem')} no kit: {ignorados.join(', ')}.
        </Callout>
      )}

      <Switch
        checked={modoJson}
        onChange={alternarModoJson}
        label="Editar como JSON"
        description="Modo avançado: mostra o kit inteiro, incluindo rótulos de ângulo, regras por estratégia e personas sugeridas."
      />

      {modoJson ? (
        <Field label="Kit (JSON)" hint="Identificador, versão e schema são definidos pelo servidor.">
          <Textarea rows={18} spellCheck={false} value={jsonTexto} onChange={(e) => setJsonTexto(e.target.value)} />
        </Field>
      ) : (
        <>
          <FormSection title="Identificação">
            <Field label={marca ? 'Nome da marca' : 'Nome do nicho'} required>
              <Input maxLength={LIMITE_NOME} value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
            </Field>
            {marca && (
              <Field label="Resumo da marca" optional hint="1 a 3 frases: o que vende, para quem e o que a torna diferente.">
                <Textarea rows={3} maxLength={LIMITE_DESCRICAO} value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} />
              </Field>
            )}
          </FormSection>

          {secoesDoKit(kind).map((secao) => (
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

          <FormSection
            title={marca ? 'Ângulos liberados' : 'Ângulos recomendados'}
            description={marca ? 'Nenhum marcado libera todos os ângulos para a marca.' : 'Os ângulos que costumam funcionar melhor nesse nicho.'}
          >
            {!marca && (
              <Switch
                checked={form.vestuario}
                onChange={(v) => setForm({ ...form, vestuario: v })}
                label="Produtos de vestuário"
                description="Libera os ângulos só para roupa, como cabide, caimento e close na estampa."
              />
            )}
            {angles.length === 0 && <Callout tone="info">A lista de ângulos aparece quando o serviço do gerador responde.</Callout>}
            <div role="group" aria-label={marca ? 'Ângulos liberados' : 'Ângulos recomendados'} className="criativos-lista-check">
              {angles.map((a) => (
                <Checkbox
                  key={a.id}
                  label={a.label}
                  description={a.description + (a.apparel_only ? ' (só vestuário)' : '')}
                  checked={form.angulos.includes(a.id)}
                  onChange={() => alternarAngulo(a.id)}
                  name={campoAngulos}
                />
              ))}
            </div>
          </FormSection>

          {marca && (
            <FormSection title="Padrões da geração" description="Usados quando a geração não escolhe outro nicho ou contexto.">
              <FormGrid>
                <Field label="Nicho padrão" optional hint="Sem escolha, o gerador usa o nicho de comércio genérico.">
                  <Select value={form.nichoPadrao} onChange={(e) => setForm({ ...form, nichoPadrao: e.target.value })}>
                    <option value="">Automático</option>
                    {nichosEmbutidos.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                  </Select>
                </Field>
                <Field label="Contexto padrão" optional>
                  <Select value={form.contextoPadrao} onChange={(e) => setForm({ ...form, contextoPadrao: e.target.value })}>
                    <option value="">Automático</option>
                    {PROVEDORES_CONTEXTO.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </Select>
                </Field>
              </FormGrid>
            </FormSection>
          )}
        </>
      )}

      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
      <FormActions start={<Button variant="ghost" onClick={onDescartar}>Descartar</Button>}>
        <Button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : editando ? `Salvar v${editando.version + 1}` : 'Salvar'}</Button>
      </FormActions>

      <ChatGptModal open={chatAberto} onClose={() => setChatAberto(false)} prompt={prompt} onAplicar={aplicarResposta} />
    </FormStack>
  );
}
