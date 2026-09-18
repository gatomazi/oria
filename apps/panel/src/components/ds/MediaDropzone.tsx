import { useRef, useState, type DragEvent } from 'react';
import { Button } from './Button';

export type MediaDropzoneAccept = 'image' | 'video' | 'document';

const ACCEPT_MIME: Record<MediaDropzoneAccept, string> = {
  image: 'image/jpeg,image/png',
  video: 'video/mp4,video/3gpp',
  document: 'application/pdf',
};

interface UploadedFile {
  filename: string;
  sizeBytes: number;
  previewUrl: string;
}

interface MediaDropzoneProps {
  accept: MediaDropzoneAccept;
  value: UploadedFile | null;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => void;
  erro?: string | null;
  // Sobrescreve os tipos do seletor de arquivo. O padrão de "image" é JPEG/PNG porque o header de
  // template da Meta só aceita esses; telas sem essa restrição (ex.: produto do gerador) ampliam aqui.
  acceptMime?: string;
}

function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Estados idle/dragging/uploading/uploaded/error (spec — Parte "Dropzone"). Um arquivo só por vez
// (header de template aceita 1 mídia) — troca substitui, nunca acumula múltiplos.
export function MediaDropzone({ accept, value, onUpload, onRemove, erro, acceptMime }: MediaDropzoneProps) {
  const [estado, setEstado] = useState<'idle' | 'dragging' | 'uploading' | 'error'>('idle');
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const enviandoRef = useRef(false);

  async function processar(file: File) {
    if (enviandoRef.current) return; // impede upload duplicado por double click/drop duplo
    enviandoRef.current = true;
    setErroLocal(null);
    setEstado('uploading');
    try {
      await onUpload(file);
      setEstado('idle');
    } catch (err) {
      setErroLocal((err as Error).message);
      setEstado('error');
    } finally {
      enviandoRef.current = false;
    }
  }

  function onDrop(ev: DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    setEstado('idle');
    const file = ev.dataTransfer.files?.[0];
    if (file) processar(file);
  }

  const mensagemErro = erro || erroLocal;

  if (value) {
    return (
      <div className="ds-media-dropzone ds-media-dropzone--uploaded">
        {accept === 'image' ? (
          <img src={value.previewUrl} alt={value.filename} className="ds-media-dropzone__preview" />
        ) : (
          <div className="ds-media-dropzone__file-icon">{accept === 'video' ? '▶' : '▣'}</div>
        )}
        <div className="ds-media-dropzone__info">
          <strong>{value.filename}</strong>
          <span>{formatarTamanho(value.sizeBytes)}</span>
        </div>
        <div className="ds-media-dropzone__acoes">
          <Button variant="secondary" onClick={() => inputRef.current?.click()}>
            Trocar
          </Button>
          <Button variant="ghost" onClick={onRemove}>
            Remover
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={acceptMime ?? ACCEPT_MIME[accept]}
          className="ds-sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) processar(file);
            e.target.value = '';
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <div
        className={`ds-media-dropzone ${estado === 'dragging' ? 'ds-media-dropzone--dragging' : ''} ${estado === 'error' ? 'ds-media-dropzone--error' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => estado !== 'uploading' && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && estado !== 'uploading') inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setEstado('dragging');
        }}
        onDragLeave={() => setEstado('idle')}
        onDrop={onDrop}
      >
        {estado === 'uploading' ? (
          <span>Enviando…</span>
        ) : (
          <>
            <strong>Arraste e solte para carregar</strong>
            <span>Ou escolha arquivos no seu dispositivo</span>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={acceptMime ?? ACCEPT_MIME[accept]}
          className="ds-sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) processar(file);
            e.target.value = '';
          }}
        />
      </div>
      {mensagemErro && <p className="ds-form-error">{mensagemErro}</p>}
    </div>
  );
}
