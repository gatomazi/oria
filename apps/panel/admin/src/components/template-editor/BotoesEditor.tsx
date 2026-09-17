import { Button } from '../ds/Button';
import { Icon } from '../ds/Icon';
import { VariavelSelect } from './VariavelSelect';

// Porte de renderBotoesEditor() em template-editor.js — controlado (`value`/`onChange`). Ao
// contrário do vanilla (que só filtrava botões sem texto na hora de coletar pro envio), aqui
// TODO botão em edição fica em `value` (mesmo com texto vazio) — use `filtrarBotoesParaEnvio()`
// antes de mandar pra API, igual o `getValores()` original fazia.
export type BotaoTipoUI = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
export type UrlTipoUI = 'ESTATICO' | 'DINAMICO';

export interface BotaoEditorValue {
  tipo: BotaoTipoUI;
  texto: string;
  valor: string;
  urlTipo?: UrlTipoUI;
  variavel?: string;
}

export function filtrarBotoesParaEnvio(botoes: BotaoEditorValue[]) {
  return botoes
    .map((b) => {
      const out: { tipo: string; texto: string; valor: string; urlTipo?: string; variavel?: string } = {
        tipo: b.tipo,
        texto: b.texto.trim(),
        valor: b.valor.trim(),
      };
      if (b.tipo === 'URL') {
        out.urlTipo = b.urlTipo;
        if (b.urlTipo === 'DINAMICO') out.variavel = b.variavel;
      }
      return out;
    })
    .filter((b) => b.texto);
}

const TIPO_OPCOES: [BotaoTipoUI, string][] = [
  ['QUICK_REPLY', 'Resposta rápida'],
  ['URL', 'Link'],
  ['PHONE_NUMBER', 'Telefone'],
];
const URL_TIPO_OPCOES: [UrlTipoUI, string][] = [
  ['ESTATICO', 'Link estático'],
  ['DINAMICO', 'Link dinâmico ({{1}})'],
];

function novaLinha(): BotaoEditorValue {
  return { tipo: 'QUICK_REPLY', texto: '', valor: '' };
}

interface BotoesEditorProps {
  tipo: string | null | undefined;
  value: BotaoEditorValue[];
  onChange: (value: BotaoEditorValue[]) => void;
}

export function BotoesEditor({ tipo, value, onChange }: BotoesEditorProps) {
  function atualizar(i: number, patch: Partial<BotaoEditorValue>) {
    const next = value.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  }

  function alternarUrlTipo(i: number, urlTipo: UrlTipoUI) {
    const linha = value[i];
    let valor = linha.valor.trim();
    const temToken = /\{\{1\}\}\s*$/.test(valor);
    if (urlTipo === 'DINAMICO' && !temToken) valor = valor + '{{1}}';
    else if (urlTipo === 'ESTATICO' && temToken) valor = valor.replace(/\{\{1\}\}\s*$/, '');
    atualizar(i, { urlTipo, valor });
  }

  function remover(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  function adicionar() {
    if (value.length >= 3) return;
    onChange([...value, novaLinha()]);
  }

  return (
    <div className="ad-botoes-lista">
      {value.map((linha, i) => {
        const ehUrl = linha.tipo === 'URL';
        const ehDinamico = ehUrl && linha.urlTipo === 'DINAMICO';
        const placeholderValor = ehDinamico ? 'https://seusite.com/{{1}}' : ehUrl ? 'https://…' : '5548999998888';
        return (
          <div className="ad-botao-linha" key={i}>
            <select className="ds-select" aria-label={`Tipo do botão ${i + 1}`} value={linha.tipo} onChange={(e) => atualizar(i, { tipo: e.target.value as BotaoTipoUI })}>
              {TIPO_OPCOES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="ds-input"
              aria-label={`Texto do botão ${i + 1}`}
              placeholder="Texto do botão"
              maxLength={25}
              value={linha.texto}
              onChange={(e) => atualizar(i, { texto: e.target.value })}
            />
            {linha.tipo !== 'QUICK_REPLY' && (
              <input
                type="text"
                className="ds-input"
                aria-label={`${ehUrl ? 'Endereço' : 'Telefone'} do botão ${i + 1}`}
                placeholder={placeholderValor}
                value={linha.valor}
                onChange={(e) => atualizar(i, { valor: e.target.value })}
              />
            )}
            {ehUrl && (
              <select className="ds-select" aria-label={`Tipo de link do botão ${i + 1}`} value={linha.urlTipo || 'ESTATICO'} onChange={(e) => alternarUrlTipo(i, e.target.value as UrlTipoUI)}>
                {URL_TIPO_OPCOES.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            )}
            {ehDinamico && (
              <VariavelSelect tipo={tipo} value={linha.variavel || ''} onChange={(e) => atualizar(i, { variavel: e.target.value })} />
            )}
            <button type="button" className="ds-icon-btn" aria-label={`Remover botão ${i + 1}`} title="Remover botão" onClick={() => remover(i)}>
              <Icon name="close" size={16} />
            </button>
          </div>
        );
      })}
      <Button variant="ghost" disabled={value.length >= 3} onClick={adicionar}>
        {value.length >= 3 ? 'Máximo de 3 botões' : 'Adicionar botão'}
      </Button>
    </div>
  );
}
