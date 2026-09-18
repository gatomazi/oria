import { api } from './client';

export type MediaKind = 'image' | 'video' | 'document';

export interface MediaAsset {
  id: number;
  loja: string | null;
  kind: MediaKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  metaHandlePronto: boolean;
  criadoEm: string;
  previewUrl: string;
}

export interface UploadMediaResult {
  ok: true;
  asset: MediaAsset;
  avisoMeta: string | null;
}

function lerComoBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('não foi possível ler o arquivo'));
    reader.readAsDataURL(file);
  });
}

// Base64 dentro do JSON — mesmo padrão já usado pra arte de produto neste painel (server.js
// eleva o limite do express.json pra 100mb exatamente por isso), não multipart. `loja` é opcional
// — o WhatsApp/WABA é 1 conta só compartilhada entre as lojas, template não é "de uma loja".
export async function uploadMedia(file: File): Promise<UploadMediaResult> {
  const dataBase64 = await lerComoBase64(file);
  return api<UploadMediaResult>('/api/admin/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, mimeType: file.type, dataBase64 }),
  });
}

export function listMedia(kind?: MediaKind) {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  return api<{ assets: MediaAsset[] }>(`/api/admin/media?${params.toString()}`);
}

export function deleteMedia(id: number) {
  return api(`/api/admin/media/${id}`, { method: 'DELETE' });
}
