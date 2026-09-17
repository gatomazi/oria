import { useEffect } from 'react';
import { chaveValidaParaTipo } from '../../lib/templateVariables';
import { VariavelSelect } from './VariavelSelect';

// Porte de renderCorpoVariaveisEditor() em template-editor.js — controlado (`value`/`onChange`)
// em vez de imperativo. `value[i]` é a chave escolhida pra variável {{i+1}} do corpo.
interface CorpoVariaveisEditorProps {
  count: number;
  tipo: string | null | undefined;
  value: string[];
  onChange: (value: string[]) => void;
}

export function CorpoVariaveisEditor({ count, tipo, value, onChange }: CorpoVariaveisEditorProps) {
  // Descarta seleção que não é mais válida pro novo tipo (pedido/carrinho) — mesmo
  // comportamento do `definirTipo` original — e resincroniza o tamanho do array com `count`:
  // sem isso, remover um {{n}} do corpo (editando o texto direto) deixa uma entrada antiga
  // "invisível" sobrando no array (a UI só renderiza os primeiros `count` itens), e o envio
  // falha com "selecione N variável(is)" mesmo com os selects visíveis todos preenchidos.
  useEffect(() => {
    const filtrado = Array.from({ length: count }, (_, i) => {
      const v = value[i];
      return v && chaveValidaParaTipo(v, tipo) ? v : '';
    });
    if (filtrado.length !== value.length || filtrado.some((v, i) => v !== value[i])) onChange(filtrado);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipo, count]);

  const values = Array.from({ length: count }, (_, i) => value[i] || '');

  function setAt(i: number, chave: string) {
    const next = values.slice();
    next[i] = chave;
    onChange(next);
  }

  return (
    <>
      {values.map((v, i) => (
        <div className="pa-field" key={i}>
          <label>Variável para {'{{' + (i + 1) + '}}'}</label>
          <VariavelSelect tipo={tipo} value={v} onChange={(e) => setAt(i, e.target.value)} />
        </div>
      ))}
    </>
  );
}
