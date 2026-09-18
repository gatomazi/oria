import { useState } from 'react';
import { useAuth } from './AuthContext';
import { Button } from '../components/ds';

// Fase 3: quem tem mais de uma Organization escolhe aqui em qual trabalhar. A escolha é uma
// proposta — o servidor confere o membership antes de gravar na sessão. Sem Organization (ou sem
// Store), a tela só explica; nada é escolhido por conta própria.
const MENSAGENS: Record<string, string> = {
  ORGANIZATION_CONTEXT_REQUIRED: 'Escolha a loja em que você vai trabalhar.',
  ORGANIZATION_ACCESS_REVOKED: 'Seu acesso à loja que estava aberta foi removido. Escolha outra para continuar.',
  NO_ORGANIZATION_MEMBERSHIP: 'Sua conta ainda não tem acesso a nenhuma loja. Peça um convite ao responsável.',
  STORE_NOT_FOUND: 'Esta organização ainda não tem uma loja ativa. Fale com o suporte.',
};

export function WorkspacePage() {
  const { memberships, codigoOrganizacao, selecionarOrganizacao, logout, usuario } = useAuth();
  const [enviando, setEnviando] = useState<string | null>(null);
  const [erro, setErro] = useState('');
  const mensagem = MENSAGENS[codigoOrganizacao || ''] || 'Não foi possível abrir sua loja agora.';
  const podeEscolher = memberships.length > 0 && codigoOrganizacao !== 'NO_ORGANIZATION_MEMBERSHIP';

  function escolher(id: string) {
    setErro('');
    setEnviando(id);
    selecionarOrganizacao(id).catch((err: Error) => {
      setErro(err.message);
      setEnviando(null);
    });
  }

  return (
    <div className="ad-login-root">
      <main className="ad-login">
        <section className="ad-login__panel" aria-labelledby="ad-workspace-titulo">
          <h1 id="ad-workspace-titulo" className="ad-login__title">Suas lojas</h1>
          <p className="ad-workspace__texto">{mensagem}</p>
          {podeEscolher && (
            <ul className="ad-workspace__lista">
              {memberships.map((m) => (
                <li key={m.organizationId}>
                  <Button
                    block
                    variant="secondary"
                    disabled={enviando !== null}
                    onClick={() => escolher(m.organizationId)}
                  >
                    {m.nome}
                    <span className="ad-workspace__papel">{m.papel === 'owner' ? 'Responsável' : 'Equipe'}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="ad-login__erro" role="alert">{erro}</p>
          <Button variant="ghost" block onClick={() => { logout(); }}>
            Sair{usuario ? ` (${usuario.email})` : ''}
          </Button>
        </section>
      </main>
    </div>
  );
}
