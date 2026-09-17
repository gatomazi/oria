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
  Textarea,
} from '../../components/ds';
import { toast } from '../../lib/toast';
import { plural } from '../../lib/format';
import { createProfile, updateProfile, type Catalog } from '../../api/criativos';
import { ChatGptModal } from './ChatGptModal';
import {
  CAMPOS_PERSONA,
  lerRespostaDaPersona,
  montarPromptPersona,
  personaDeDados,
  type CampoPersona,
  type DadosPersona,
} from './personaTemplate';

// Formulário guiado da persona, no mesmo molde do KitEditor: atalho "Preencher com ChatGPT" e ponto
// de partida nas personas sugeridas pelos kits prontos. Sem modo JSON: o formulário cobre o contrato
// inteiro. O servidor continua validando pelo contrato do core no salvar.

interface PersonaEditorProps {
  catalog: Catalog | null;
  inicial: Record<string, unknown> | null;
  editando: { id: string; version: number } | null;
  onSalvo: () => void;
  onDescartar: () => void;
}

const campo = (key: CampoPersona['key']) => CAMPOS_PERSONA.find((c) => c.key === key) as CampoPersona;

export function PersonaEditor({ catalog, inicial, editando, onSalvo, onDescartar }: PersonaEditorProps) {
  const [form, setForm] = useState<DadosPersona>(() => personaDeDados(inicial));
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [chatAberto, setChatAberto] = useState(false);
  const [ignorados, setIgnorados] = useState<string[]>([]);
  const prompt = useMemo(montarPromptPersona, []);

  // Personas sugeridas pelos kits prontos (marca e nicho), sem repetir rótulo.
  const sugeridas = useMemo(() => {
    const kits = [...(catalog?.catalog.builtin_kits.brand ?? []), ...(catalog?.catalog.builtin_kits.niche ?? [])];
    const porRotulo = new Map<string, DadosPersona>();
    for (const kit of kits) {
      const lista = Array.isArray(kit.suggestedPersonas) ? kit.suggestedPersonas : [];
      for (const p of lista) {
        const persona = personaDeDados(p as Record<string, unknown>);
        if (persona.label && !porRotulo.has(persona.label)) porRotulo.set(persona.label, persona);
      }
    }
    return [...porRotulo.values()];
  }, [catalog]);

  const input = (key: CampoPersona['key']) => {
    const c = campo(key);
    return <Input maxLength={c.limite} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />;
  };
  const texto = (key: CampoPersona['key'], rows = 2) => {
    const c = campo(key);
    return <Textarea rows={rows} maxLength={c.limite} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />;
  };

  // Lança o erro de leitura para o ChatGptModal mostrar.
  function aplicarResposta(resposta: string) {
    const leitura = lerRespostaDaPersona(resposta);
    setForm((f) => ({ ...f, ...leitura.data }));
    setIgnorados(leitura.ignorados);
    toast('Formulário preenchido. Revise antes de salvar.', 'sucesso');
  }

  function salvar(ev: FormEvent) {
    ev.preventDefault();
    setErro('');
    if (!form.label.trim()) {
      setErro('Descreva quem é a persona.');
      return;
    }
    const dados = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    setSalvando(true);
    const acao = editando ? updateProfile('personas', editando.id, dados) : createProfile('personas', dados);
    acao
      .then(() => { toast(editando ? 'Nova versão salva.' : 'Persona cadastrada.', 'sucesso'); onSalvo(); })
      .catch((e: Error) => setErro(e.message))
      .finally(() => setSalvando(false));
  }

  return (
    <FormStack wide onSubmit={salvar}>
      <Callout
        tone="info"
        title="Não sabe como descrever?"
        action={<Button size="sm" variant="secondary" onClick={() => setChatAberto(true)}>Preencher com ChatGPT</Button>}
      >
        Copie um prompt pronto, responda às perguntas sobre seu cliente no ChatGPT e cole a resposta aqui. O formulário é preenchido para você revisar.
      </Callout>

      {!editando && sugeridas.length > 0 && (
        <Field label="Ou partir de uma persona sugerida" optional hint="Copia uma persona dos kits prontos para você adaptar.">
          <Select defaultValue="" onChange={(e) => { const p = sugeridas.find((s) => s.label === e.target.value); if (p) { setForm(p); setIgnorados([]); } }}>
            <option value="">Escolha…</option>
            {sugeridas.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
          </Select>
        </Field>
      )}

      {ignorados.length > 0 && (
        <Callout tone="warning" title="Parte da resposta foi ignorada">
          {plural(ignorados.length, 'campo não existe', 'campos não existem')} na persona: {ignorados.join(', ')}.
        </Callout>
      )}

      <FormSection title="Identificação" description="O rótulo entra no lugar de “uma pessoa” na descrição da cena.">
        <FormGrid>
          <Field label={campo('label').label} required hint={campo('label').hint}>{input('label')}</Field>
          <Field label={campo('age_range').label} optional hint={campo('age_range').hint}>{input('age_range')}</Field>
        </FormGrid>
      </FormSection>

      <FormSection title="Como aparece na foto">
        <FormGrid min={280}>
          {(['appearance', 'style', 'behavior', 'notes'] as const).map((key) => (
            <Field key={key} label={campo(key).label} optional hint={campo(key).hint}>{texto(key, 3)}</Field>
          ))}
        </FormGrid>
      </FormSection>

      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
      <FormActions start={<Button variant="ghost" onClick={onDescartar}>Descartar</Button>}>
        <Button type="submit" disabled={salvando}>{salvando ? 'Salvando…' : editando ? `Salvar v${editando.version + 1}` : 'Salvar'}</Button>
      </FormActions>

      <ChatGptModal open={chatAberto} onClose={() => setChatAberto(false)} prompt={prompt} onAplicar={aplicarResposta} assunto="o seu cliente" />
    </FormStack>
  );
}
