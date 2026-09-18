import { useLojaAtiva } from '../../auth/AuthContext';
import { useRef, useState } from 'react';
import { Button, ConfirmDialog, Field, FormActions, Input, StatusBadge } from '../../components/ds';
import { InserirVariaveis } from '../../components/template-editor';
import { adminStores } from '../../state/adminStores';
import { excluirCampoCustomizado, salvarCampoCustomizado, type CampoCustomizado } from '../../api/campos';

// Porte de renderCampo() em src/campos.js. Os inputs "valor por loja" são não-controlados
// (via ref, `defaultValue`) de propósito — clicar num dado do painel de variáveis insere texto
// na posição do cursor do campo que estiver focado, igual `inserirTextoEm()` no vanilla, o que
// exige manipular o DOM do input diretamente em vez de passar pelo ciclo de re-render do React.
function inserirTextoEm(campo: HTMLInputElement | null, texto: string) {
  if (!campo) return;
  const start = campo.selectionStart ?? campo.value.length;
  const end = campo.selectionEnd ?? campo.value.length;
  campo.value = campo.value.slice(0, start) + texto + campo.value.slice(end);
  const novaPos = start + texto.length;
  campo.focus();
  campo.setSelectionRange?.(novaPos, novaPos);
}

export function CampoCard({ chave, campo, recarregar }: { chave: string; campo: CampoCustomizado; recarregar: () => void }) {
  // Só a loja da Organization ativa: o servidor recusa valor de qualquer outra.
  const lojaAtiva = useLojaAtiva();
  const infoLoja = lojaAtiva ? adminStores.get(lojaAtiva) : null;
  const lojas = lojaAtiva ? [infoLoja ?? { id: lojaAtiva, name: lojaAtiva, shortName: lojaAtiva, color: adminStores.color(lojaAtiva) }] : [];
  const labelRef = useRef<HTMLInputElement>(null);
  const valorRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const campoAtivoRef = useRef<HTMLInputElement | null>(null);

  const [msg, setMsg] = useState('');
  const [msgErro, setMsgErro] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);
  const [aberto, setAberto] = useState(false);

  function salvar() {
    setMsg('');
    setMsgErro(false);
    const label = labelRef.current?.value.trim() || '';
    if (!label) {
      setMsgErro(true);
      setMsg('informe um nome');
      return;
    }
    const valores: Record<string, string> = {};
    lojas.forEach((s) => {
      valores[s.id] = valorRefs.current[s.id]?.value.trim() || '';
    });

    setSalvando(true);
    salvarCampoCustomizado(chave, label, valores)
      .then(() => {
        setMsgErro(false);
        setMsg('salvo!');
      })
      .catch((err: Error) => {
        setMsgErro(true);
        setMsg(err.message);
      })
      .finally(() => setSalvando(false));
  }

  async function excluir() {
    await excluirCampoCustomizado(chave);
    recarregar();
  }

  // Linha da lista "Campos existentes" (não é um card: a lista já está dentro de um — DESIGN.md › No Nesting).
  return (
    <div className="ad-campo-item">
      <div className="ad-vinculo-topo">
        <strong>{campo.label}</strong>
        <StatusBadge tone="neutral" label={`custom.${chave}`} />
        <Button variant="ghost" size="sm" className="ad-vinculo-topo__acao" aria-expanded={aberto} onClick={() => setAberto((v) => !v)}>
          {aberto ? 'Esconder' : 'Editar'}
        </Button>
      </div>

      {aberto && (
        <div className="ds-form">
          <Field label="Nome" hint="Como aparece na lista de variáveis.">
            <Input ref={labelRef} type="text" defaultValue={campo.label} />
          </Field>

          {lojas.map((s, i) => (
            <Field label={`Valor para ${s.name}`} key={s.id}>
              <Input
                ref={(node) => {
                  valorRefs.current[s.id] = node;
                  if (i === 0 && !campoAtivoRef.current) campoAtivoRef.current = node;
                }}
                type="text"
                placeholder="ex: https://rastreio.com/{{cliente.documento}}/{{pedido.numero}}"
                defaultValue={(campo.valores && campo.valores[s.id]) || ''}
                onFocus={(e) => {
                  campoAtivoRef.current = e.currentTarget;
                }}
              />
            </Field>
          ))}

          <InserirVariaveis tipo={null} aoClicar={(chaveVar) => inserirTextoEm(campoAtivoRef.current, `{{${chaveVar}}}`)} />

          {msg && (
            <p className={msgErro ? 'ds-form-error' : 'ds-form-note'} role={msgErro ? 'alert' : undefined}>
              {msg}
            </p>
          )}
          <FormActions
            start={
              <Button variant="danger" onClick={() => setConfirmandoExclusao(true)}>
                Excluir campo
              </Button>
            }
          >
            <Button disabled={salvando} onClick={salvar}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </Button>
          </FormActions>
        </div>
      )}
      <ConfirmDialog
        open={confirmandoExclusao}
        onClose={() => setConfirmandoExclusao(false)}
        title={`Excluir o campo "${campo.label}"?`}
        description="Templates que já usam esse campo ficam sem essa variável preenchida."
        onConfirm={excluir}
      />
    </div>
  );
}
