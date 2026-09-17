import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { LoginPage } from './LoginPage';
import { WorkspacePage } from './WorkspacePage';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, organizacaoAtiva, codigoOrganizacao } = useAuth();
  if (status === 'loading') return null;
  if (status === 'anonymous') return <LoginPage />;
  // Fase 3: sem Organization ativa (e Store) não há painel — nenhuma tela abre "sem loja".
  if (!organizacaoAtiva || codigoOrganizacao) return <WorkspacePage />;
  return <>{children}</>;
}
