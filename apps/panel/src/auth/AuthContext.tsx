import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, definirCsrfToken, EVENTO_CONTEXTO_ORGANIZACAO } from '../api/client';

// Fase 2: identidade individual. Fase 3: a Organization ativa (workspace) é decidida e gravada no
// servidor — o navegador só lê `organizacaoAtiva` e, quando a pessoa tem mais de um membership,
// propõe uma troca em POST /api/admin/session/organization. Nenhuma chamada de negócio manda
// organização ou loja: o backend recusa (TENANT_SELECTOR_NOT_ALLOWED).
type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface Usuario {
  id: string;
  email: string;
  nome: string | null;
}

export interface Membership {
  organizationId: string;
  nome: string;
  papel: 'owner' | 'member';
}

export interface OrganizacaoAtiva {
  id: string;
  nome: string;
  papel: 'owner' | 'member';
  // Loja da Store da Organization — só para exibir nome/cor. Nunca volta para o servidor.
  loja: string | null;
  // Identidade da Store (só leitura): id, nome, e a chave de escopo dos mapas por loja
  // (`loja` legada quando existe; `storeId` na Store nativa). Nenhuma delas é enviada ao servidor.
  storeId?: string | null;
  storeNome?: string | null;
  chaveEscopo?: string | null;
}

// Por que não há Organization ativa (vem do servidor):
//   ORGANIZATION_CONTEXT_REQUIRED  mais de um membership, nenhum escolhido
//   ORGANIZATION_ACCESS_REVOKED    o membership da escolhida foi removido
//   NO_ORGANIZATION_MEMBERSHIP     nenhum membership
//   STORE_NOT_FOUND                a Organization não tem Store ativa
export type CodigoOrganizacao =
  | 'ORGANIZATION_CONTEXT_REQUIRED'
  | 'ORGANIZATION_ACCESS_REVOKED'
  | 'NO_ORGANIZATION_MEMBERSHIP'
  | 'STORE_NOT_FOUND'
  | string;

interface SessaoResposta {
  authenticated: boolean;
  user?: Usuario;
  csrfToken?: string;
  memberships?: Membership[];
  organizacaoAtiva?: OrganizacaoAtiva | null;
  codigoOrganizacao?: CodigoOrganizacao | null;
}

interface AuthContextValue {
  status: AuthStatus;
  usuario: Usuario | null;
  memberships: Membership[];
  organizacaoAtiva: OrganizacaoAtiva | null;
  codigoOrganizacao: CodigoOrganizacao | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selecionarOrganizacao: (organizationId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [organizacaoAtiva, setOrganizacaoAtiva] = useState<OrganizacaoAtiva | null>(null);
  const [codigoOrganizacao, setCodigoOrganizacao] = useState<CodigoOrganizacao | null>(null);

  const aplicar = useCallback((data: SessaoResposta) => {
    if (data.authenticated && data.user) {
      definirCsrfToken(data.csrfToken || null);
      setUsuario(data.user);
      setMemberships(data.memberships || []);
      setOrganizacaoAtiva(data.organizacaoAtiva || null);
      setCodigoOrganizacao(data.codigoOrganizacao || null);
      setStatus('authenticated');
    } else {
      definirCsrfToken(null);
      setUsuario(null);
      setMemberships([]);
      setOrganizacaoAtiva(null);
      setCodigoOrganizacao(null);
      setStatus('anonymous');
    }
  }, []);

  const checkSession = useCallback(() => {
    return api<SessaoResposta>('/api/admin/session')
      .then(aplicar)
      .catch(() => aplicar({ authenticated: false }));
  }, [aplicar]);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Uma chamada qualquer descobriu que a Organization ativa deixou de valer (membership removido,
  // escolha pendente): relê a sessão, e a tela de escolha assume. Nunca troca por conta própria.
  useEffect(() => {
    const aoPerder = () => { checkSession(); };
    window.addEventListener(EVENTO_CONTEXTO_ORGANIZACAO, aoPerder);
    return () => window.removeEventListener(EVENTO_CONTEXTO_ORGANIZACAO, aoPerder);
  }, [checkSession]);

  const login = useCallback(
    (email: string, password: string) => {
      // E-mail vazio = login legado de emergência (só funciona com a flag ligada no servidor).
      const corpo = email.trim() ? { email: email.trim(), password } : { password };
      return api('/api/admin/login', { method: 'POST', body: JSON.stringify(corpo), toast: false }).then(checkSession);
    },
    [checkSession],
  );

  const logout = useCallback(() => {
    return api('/api/admin/logout', { method: 'POST' })
      .then(() => undefined)
      .finally(() => aplicar({ authenticated: false }));
  }, [aplicar]);

  const selecionarOrganizacao = useCallback((organizationId: string) => {
    return api('/api/admin/session/organization', {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
    }).then(() => {
      // Recarrega a aplicação inteira: caches de tela (plano, configurações, listas) são da
      // Organization anterior e não podem aparecer na nova.
      window.location.reload();
    });
  }, []);

  return (
    <AuthContext.Provider
      value={{ status, usuario, memberships, organizacaoAtiva, codigoOrganizacao, login, logout, selecionarOrganizacao }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>');
  return ctx;
}

// Loja da Store ativa, só para exibição. Nenhuma chamada de API a recebe.
export function useLojaAtiva(): string | null {
  return useAuth().organizacaoAtiva?.loja ?? null;
}

// Chave sob a qual o servidor guarda o estado por loja (vínculos de automação, histórico de envios).
// Store com chave legada: a própria chave. Store nativa: o `store_id`. Nunca vazia com Store ativa.
export function useChaveDaStore(): string {
  const o = useAuth().organizacaoAtiva;
  return o?.chaveEscopo ?? o?.loja ?? o?.storeId ?? '';
}

// Nome da Store para exibição: o registro (Store nativa) ou o nome da chave legada.
export function useNomeDaStore(): string {
  const o = useAuth().organizacaoAtiva;
  return o?.storeNome ?? '';
}
