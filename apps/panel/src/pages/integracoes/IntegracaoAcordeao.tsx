import { createContext, useContext, type ReactNode } from 'react';
import { Icon, StatusBadge } from '../../components/ds';
import { useAuth } from '../../auth/AuthContext';
import type { ResumoProvedor } from './estadoIntegracao';

// Card expansível de um provedor (Integrações). Um <h3> com um <button> que controla a região
// (`aria-expanded` + `aria-controls`), como no padrão de accordion do WAI-ARIA. O corpo só é
// montado enquanto aberto: fechar interrompe polling e descarta o que foi digitado (nenhum
// segredo digitado fica preso num card recolhido), e abrir é quando o provedor é consultado.

const ICONE: Record<string, string> = {
  ink: '<path d="M4 9h16l-1.5-5h-13L4 9z"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/>',
  whatsapp: '<path d="M4 4h16v12H8l-4 4V4z"/><path d="M8 9h8"/><path d="M8 12h5"/>',
  instagram:
    '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="12" cy="12" r="3.5"/><circle cx="17" cy="8.3" r=".6" fill="currentColor" stroke="none"/>',
  meta_ads: '<path d="M3 17l5-6 4 4 5-7"/><path d="M14 8h4v4"/><path d="M3 21h18"/>',
  google_ads: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v9"/><path d="M8.2 9.7l7.6 4.6"/><path d="M15.8 9.7l-7.6 4.6"/>',
  ga4: '<path d="M3 20h18"/><rect x="5" y="11" width="3.5" height="6" rx="1"/><rect x="10.25" y="7" width="3.5" height="10" rx="1"/><rect x="15.5" y="4" width="3.5" height="13" rx="1"/>',
  openai:
    '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z"/>',
};

interface AcordeaoProps {
  provider: string;
  nome: string;
  descricao: string;
  resumo: ResumoProvedor | null;
  aberto: boolean;
  // Sem `onAlternar` o item é só informativo (ex.: "Em breve"): sem chevron, sem botão falso.
  onAlternar?: () => void;
  children?: ReactNode;
}

export function idDoCabecalho(provider: string): string {
  return `integracao-${provider}-cabecalho`;
}

export function IntegracaoAcordeao({ provider, nome, descricao, resumo, aberto, onAlternar, children }: AcordeaoProps) {
  const idCorpo = `integracao-${provider}-corpo`;
  const idCabecalho = idDoCabecalho(provider);
  const expansivel = !!onAlternar;

  const conteudo = (
    <>
      <span className="ig-card__icone" aria-hidden="true">
        <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICONE[provider] || '' }} />
      </span>
      <span className="ig-card__texto">
        <span className="ig-card__nome">{nome}</span>
        <span className="ig-card__descricao">{descricao}</span>
      </span>
      <span className="ig-card__estado">
        {resumo ? (
          <>
            <span className="ig-card__selo">
              {/* Cor nunca é o único sinal: o estado sempre vai por escrito no selo. */}
              <StatusBadge tone={resumo.tone} label={resumo.label} />
            </span>
            {resumo.detalhe && <span className="ig-card__detalhe">{resumo.detalhe}</span>}
          </>
        ) : (
          <span className="ig-card__carregando" aria-hidden="true" />
        )}
      </span>
      {expansivel && <Icon name="chevron-down" className="ig-card__chevron" />}
    </>
  );

  return (
    <section className={'ig-card' + (aberto ? ' ig-card--aberto' : '') + (expansivel ? '' : ' ig-card--estatico')} data-provider={provider}>
      <h3 className="ig-card__titulo">
        {expansivel ? (
          <button type="button" id={idCabecalho} className="ig-card__cabecalho" aria-expanded={aberto} aria-controls={idCorpo} onClick={onAlternar}>
            {conteudo}
          </button>
        ) : (
          <span id={idCabecalho} className="ig-card__cabecalho">
            {conteudo}
          </span>
        )}
      </h3>
      {expansivel && (
        <div id={idCorpo} role="region" aria-labelledby={idCabecalho} className="ig-card__corpo" hidden={!aberto}>
          {aberto && children}
        </div>
      )}
    </section>
  );
}

// Seção interna de um provedor expandido: título curto + descrição de uma linha + conteúdo. Não é
// um cartão (sem borda nem fundo próprios) — dentro do card do provedor só há divisórias.
export function Secao({ title, description, action, children }: { title?: string; description?: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="ig-secao">
      {(title || description || action) && (
        <div className="ig-secao__topo">
          <div>
            {title && <h4 className="ig-secao__titulo">{title}</h4>}
            {description && <p className="ig-secao__descricao">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="ig-secao__corpo">{children}</div>
    </section>
  );
}

// Card de um provedor avisa a página quando mudou algo que altera o estado da linha (salvou a
// credencial, trocou de conta, desconectou). A página relê o resumo sem desmontar o card.
const AtualizarResumoContext = createContext<() => void>(() => {});
export const AtualizarResumoProvider = AtualizarResumoContext.Provider;
// Quem cria, troca ou revoga credencial/vínculo de uma integração: só o `owner` da Organization ativa (o servidor recusa o
// resto com 403 — esconder o botão é só a outra ponta da mesma regra).
export function useEhOwner(): boolean {
  return useAuth().organizacaoAtiva?.papel === 'owner';
}

export function useAtualizarResumo(): () => void {
  return useContext(AtualizarResumoContext);
}
