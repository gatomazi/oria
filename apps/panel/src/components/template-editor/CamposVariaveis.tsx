import { contarVariaveis, extrairBotaoDinamico, extrairTextosComponentes, type TemplateComponent } from '../../lib/templateVariables';
import { Field } from '../ds/Field';
import { VariavelSelect } from './VariavelSelect';

// Porte de renderCamposVariaveis() em template-editor.js — usado tanto em Automações
// (evento→template) quanto em Templates (editar vínculo existente). Controlado.
export interface CamposVariaveisValue {
  headerVariavel: string | null;
  corpoVariaveis: string[];
  botaoVariavel: string | null;
}

export interface TemplateParaCampos {
  components?: TemplateComponent[];
  config?: { tipo?: string };
}

export function camposVariaveisValido(value: CamposVariaveisValue, template: TemplateParaCampos | null | undefined): boolean {
  if (!template) return true;
  const textos = extrairTextosComponentes(template.components);
  const numHeaderVars = contarVariaveis(textos.header);
  if (numHeaderVars > 0 && !value.headerVariavel) return false;
  const numCorpoVars = contarVariaveis(textos.corpo);
  if (value.corpoVariaveis.slice(0, numCorpoVars).some((v) => !v)) return false;
  const botaoDinamicoInfo = extrairBotaoDinamico(template.components);
  if (botaoDinamicoInfo && !value.botaoVariavel) return false;
  return true;
}

interface CamposVariaveisProps {
  template: TemplateParaCampos | null | undefined;
  value: CamposVariaveisValue;
  onChange: (value: CamposVariaveisValue) => void;
}

export function CamposVariaveis({ template, value, onChange }: CamposVariaveisProps) {
  if (!template) return null;

  const textos = extrairTextosComponentes(template.components);
  const numHeaderVars = contarVariaveis(textos.header);
  const numCorpoVars = contarVariaveis(textos.corpo);
  const tipo = template.config?.tipo;
  const botaoDinamicoInfo = extrairBotaoDinamico(template.components);

  function setCorpoVar(i: number, chave: string) {
    const next = value.corpoVariaveis.slice();
    next[i] = chave;
    onChange({ ...value, corpoVariaveis: next });
  }

  return (
    <div className="ad-vinculo-vars">
      {numHeaderVars > 0 && (
        <Field label={`Variável do cabeçalho ({{1}}: "${textos.header}")`}>
          <VariavelSelect tipo={tipo} value={value.headerVariavel || ''} onChange={(e) => onChange({ ...value, headerVariavel: e.target.value })} />
        </Field>
      )}

      {Array.from({ length: numCorpoVars }).map((_, i) => (
        <Field key={i} label={`Variável do corpo para {{${i + 1}}}`}>
          <VariavelSelect tipo={tipo} value={value.corpoVariaveis[i] || ''} onChange={(e) => setCorpoVar(i, e.target.value)} />
        </Field>
      ))}

      {textos.botoes.length > 0 && (
        <div className="ad-vinculo-botoes">
          {textos.botoes.map((b, i) => {
            if (botaoDinamicoInfo && i === botaoDinamicoInfo.indice) {
              return (
                <Field key={i} label={`Botão "${b.texto}" — variável do link dinâmico`}>
                  <VariavelSelect tipo={tipo} value={value.botaoVariavel || ''} onChange={(e) => onChange({ ...value, botaoVariavel: e.target.value })} />
                </Field>
              );
            }
            const descricao =
              b.tipo === 'PHONE_NUMBER' ? `telefone fixo: ${b.valor}` : b.tipo === 'QUICK_REPLY' ? 'resposta rápida' : `link fixo: ${b.valor}`;
            return (
              <div className="ad-vinculo-botao-fixo" key={i}>
                Botão "{b.texto}" — {descricao} (sem configuração necessária)
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
