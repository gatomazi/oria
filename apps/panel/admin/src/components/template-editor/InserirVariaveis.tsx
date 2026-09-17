import { gruposParaTipo, useGruposVariaveis, type VariavelGrupo } from '../../lib/templateVariables';

// Porte de renderInserirVariaveis() em template-editor.js. `aoClicar` insere o placeholder no
// campo em foco — a página que usa este componente é quem sabe qual campo/posição do cursor
// (ver CamposPage/AutomacoesPage/TemplatesNovoPage, que guardam a ref do input focado).
// `grupos` (opcional) substitui o filtro por tipo — usado pelas mensagens do WhatsApp Web, que
// têm regra própria pro tipo "comum".
export function InserirVariaveis({
  tipo,
  aoClicar,
  grupos,
  dica = 'Clique num dado abaixo pra inserir no cabeçalho ou corpo, na posição onde estava o cursor.',
}: {
  tipo: string | null | undefined;
  aoClicar: (chave: string) => void;
  grupos?: VariavelGrupo[];
  dica?: string;
}) {
  useGruposVariaveis();
  return (
    <div className="ad-template-referencia">
      <div className="pa-field-hint">{dica}</div>
      <div className="ad-template-referencia__corpo">
        {(grupos ?? gruposParaTipo(tipo)).map((g) => (
          <div key={g.grupo} className="ad-template-referencia__grupo">
            <strong>{g.grupo}</strong>
            <div className="ad-template-referencia__lista">
              {g.itens.map((v) => (
                <button key={v.chave} type="button" className="ad-var-btn" onClick={() => aoClicar(v.chave)}>
                  <span className="ad-var-btn__label">{v.label}</span>
                  <span className="ad-var-btn__exemplo">ex: {v.exemplo}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
