import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Icon, Tooltip } from '../../components/ds';
import { useAuth } from '../../auth/AuthContext';
import { chaveModoDiscreto, gravarOculto, lerOculto } from '../../state/modoDiscreto';

// Contexto do modo discreto da Visão geral (ver src/state/modoDiscreto.ts). A preferência é lida
// de forma SÍNCRONA no primeiro render — nenhum valor financeiro chega a aparecer antes da decisão.
// Sem provider, o padrão do contexto é oculto.

interface ModoDiscretoValor {
  oculto: boolean;
  alternar: () => void;
}

const ModoDiscretoContext = createContext<ModoDiscretoValor>({ oculto: true, alternar: () => {} });

export function ModoDiscretoProvider({ children }: { children: ReactNode }) {
  const { usuario, organizacaoAtiva } = useAuth();
  const chave = chaveModoDiscreto(usuario?.id, organizacaoAtiva?.id);
  const [versao, setVersao] = useState(0);
  // `versao` só força a releitura depois de gravar (o valor em si mora no armazenamento/memória).
  const oculto = useMemo(() => lerOculto(chave), [chave, versao]);
  const alternar = useCallback(() => {
    if (!chave) return;
    gravarOculto(chave, !lerOculto(chave));
    setVersao((v) => v + 1);
  }, [chave]);
  const valor = useMemo(() => ({ oculto, alternar }), [oculto, alternar]);
  return <ModoDiscretoContext.Provider value={valor}>{children}</ModoDiscretoContext.Provider>;
}

export function useModoDiscreto(): ModoDiscretoValor {
  return useContext(ModoDiscretoContext);
}

// Marcador no lugar do valor: largura estável, sem o número em lugar nenhum (nem title, nem aria).
export function ValorOculto({ moeda = true }: { moeda?: boolean }) {
  return (
    <span className="ad-oculto">
      <span aria-hidden="true">{moeda ? 'R$ •••••' : '•••'}</span>
      <span className="ds-sr-only">valor oculto</span>
    </span>
  );
}

// Um único botão de olho para a tela inteira (no cabeçalho, ao lado do período).
export function BotaoModoDiscreto() {
  const { oculto, alternar } = useModoDiscreto();
  const rotulo = oculto ? 'Mostrar valores' : 'Ocultar valores';
  return (
    <Tooltip content={rotulo}>
      <button type="button" className="ds-btn ds-btn--secondary ad-olho" onClick={alternar} aria-label={rotulo}>
        <Icon name={oculto ? 'eye-off' : 'eye'} size={18} />
      </button>
    </Tooltip>
  );
}
