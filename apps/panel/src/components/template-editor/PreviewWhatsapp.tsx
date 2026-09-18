import { substituirVariaveis, type TemplateBotao } from '../../lib/templateVariables';

// Porte de renderPreviewWhatsapp() em template-editor.js — vira componente controlado por props
// em vez de um `.atualizar(dados)` imperativo.
export interface PreviewWhatsappProps {
  headerTexto?: string | null;
  headerChaves?: (string | null | undefined)[];
  // Header não-texto (amostra de mídia) — aproximação visual só, não tenta replicar o player/
  // preview nativo do WhatsApp (spec: "não deve tentar replicar internamente toda a UI nativa").
  headerMediaTipo?: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION' | null;
  headerMediaPreviewUrl?: string | null;
  corpoTexto?: string | null;
  corpoChaves?: (string | null | undefined)[];
  footer?: string | null;
  botoes?: (TemplateBotao & { chave?: string | null })[];
  overrides?: Record<string, string> | null;
}

const HEADER_MEDIA_LABEL: Record<string, string> = {
  IMAGE: '🖼 Imagem', VIDEO: '▶ Vídeo', DOCUMENT: '▣ Documento', LOCATION: '⌖ Localização',
};

export function PreviewWhatsapp({ headerTexto, headerChaves, headerMediaTipo, headerMediaPreviewUrl, corpoTexto, corpoChaves, footer, botoes, overrides }: PreviewWhatsappProps) {
  const header = substituirVariaveis(headerTexto, headerChaves, overrides);
  const corpo = substituirVariaveis(corpoTexto, corpoChaves, overrides);

  return (
    <div className="ad-wa-preview">
      <div className="pa-field-hint">Prévia — como a mensagem chega pro cliente (com dados de exemplo).</div>
      <div className="ad-wa-preview__bolha">
        {headerMediaTipo && headerMediaTipo === 'IMAGE' && headerMediaPreviewUrl ? (
          <img src={headerMediaPreviewUrl} alt="Amostra do cabeçalho" className="ad-wa-preview__media" />
        ) : (
          headerMediaTipo && <div className="ad-wa-preview__media-placeholder">{HEADER_MEDIA_LABEL[headerMediaTipo]}</div>
        )}
        {header && <strong className="ad-wa-preview__header">{header}</strong>}
        {corpo ? (
          <div className="ad-wa-preview__corpo">{corpo}</div>
        ) : (
          <div className="ad-wa-preview__vazio">A mensagem aparece aqui conforme você escreve…</div>
        )}
        {footer && <div className="ad-wa-preview__footer">{footer}</div>}
        {(botoes || [])
          .filter((b) => b && b.texto)
          .map((b, i) => {
            const dinamico = b.tipo === 'URL' && b.valor && /\{\{[^{}]+\}\}/.test(b.valor);
            const valorFinal = dinamico ? substituirVariaveis(b.valor, b.chave ? [b.chave] : [], overrides) : null;
            return (
              <div key={i} className="ad-wa-preview__botao">
                {b.texto}
                {dinamico && <span className="ad-wa-preview__botao-hint">{valorFinal}</span>}
              </div>
            );
          })}
      </div>
    </div>
  );
}
