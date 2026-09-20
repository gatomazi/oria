import type { ReservaInkStatus } from '../../api/integracoes';
import { adminStores } from '../../state/adminStores';

// Uma Store que os cards de Integrações podem operar. A identidade é o `storeId` (canônico); o nome
// é só rótulo. A Store nativa do Oria não tem chave legada, e por isso nunca pode ser filtrada por
// ela: antes os cards recebiam só as chaves `sul`/`centro`/`norte` e diziam "Nenhuma loja conectada"
// para quem tinha token Ink e nenhuma chave.
export interface LojaOpcao {
  id: string;
  nome: string;
}

export function lojasComTokenInk(reservaInk: ReservaInkStatus[]): LojaOpcao[] {
  return reservaInk
    .filter((item) => item.tokenConfigurado)
    .map((item) => ({ id: item.storeId, nome: item.nome || (item.loja ? adminStores.name(item.loja) : 'Sua loja') }));
}
