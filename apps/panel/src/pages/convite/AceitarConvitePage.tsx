import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Callout, Field, Input } from '../../components/ds';

// Aceite do convite de owner (docs/architecture/invite-acceptance.md). Rota ANÔNIMA do SPA: é a
// única tela que abre sem sessão além do login, e é o último passo do cadastro de um tenant novo —
// do token na mão até dentro do painel, sem curl.
//
// O token vem do fragmento da URL (`/admin/convite#<token>`) ou é colado à mão. O fragmento é a
// única parte da URL que o navegador NÃO envia ao servidor: ele não aparece em log de acesso, nem
// em Referer, nem no histórico do proxy. Ainda assim é apagado da barra assim que lido, para não
// sobreviver num print de tela ou no histórico do navegador.
//
// Visual: o mesmo painel do login e da escolha de workspace (`.ad-login*`, admin-shell.css).

interface Consulta {
  email: string;
  papel: 'owner' | 'member';
  organizationNome: string | null;
  contaExistente: boolean;
  autenticadoComo: string | null;
}

function tokenDoFragmento(): string {
  const bruto = window.location.hash.replace(/^#/, '');
  if (!bruto) return '';
  // Aceita `#token` e `#token=<...>`, que é como um link de e-mail costuma vir.
  const comChave = /^token=(.+)$/.exec(bruto);
  return decodeURIComponent(comChave ? comChave[1] : bruto).trim();
}

export function AceitarConvitePage() {
  const { logout } = useAuth();
  const [token, setToken] = useState('');
  const [convite, setConvite] = useState<Consulta | null>(null);
  const [senha, setSenha] = useState('');
  const [nome, setNome] = useState('');
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    const doLink = tokenDoFragmento();
    if (!doLink) return;
    setToken(doLink);
    // Tira o segredo da barra de endereço sem recarregar a tela nem empilhar histórico.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  function falhar(err: unknown) {
    setErro(err instanceof Error ? err.message : 'não foi possível concluir agora');
    setEnviando(false);
  }

  function consultar(ev: FormEvent) {
    ev.preventDefault();
    setErro('');
    setEnviando(true);
    api<Consulta>('/api/admin/convite/consultar', {
      method: 'POST',
      body: JSON.stringify({ token: token.trim() }),
      toast: false,
    })
      .then((c) => {
        setConvite(c);
        setEnviando(false);
      })
      .catch(falhar);
  }

  function aceitar(ev: FormEvent) {
    ev.preventDefault();
    if (!convite) return;
    setErro('');
    setEnviando(true);
    // Conta existente só é aceita com sessão autenticada daquela conta — e aí o servidor recusa
    // qualquer senha no corpo. Conta nova define a senha aqui.
    const corpo = convite.autenticadoComo
      ? { token: token.trim() }
      : { token: token.trim(), senha, ...(nome.trim() ? { nome: nome.trim() } : {}) };
    api('/api/admin/convite/aceitar', { method: 'POST', body: JSON.stringify(corpo), toast: false })
      .then(() => {
        // Recarrega o SPA inteiro: a sessão (e a Organization ativa) mudaram no servidor.
        window.location.assign('/admin');
      })
      .catch((err: unknown) => {
        // O convite volta a valer quando o aceite falha: dá para corrigir e tentar de novo.
        if (err instanceof ApiError && err.codigo === 'conta_existente') setConvite({ ...convite, contaExistente: true });
        falhar(err);
      });
  }

  const papelLegivel = convite?.papel === 'owner' ? 'responsável' : 'equipe';
  const outraConta = !!convite?.autenticadoComo && convite.autenticadoComo !== convite.email;
  const mesmaConta = !!convite?.autenticadoComo && convite.autenticadoComo === convite.email;
  const precisaEntrar = !!convite && convite.contaExistente && !convite.autenticadoComo;

  return (
    <div className="ad-login-root">
      <main className="ad-login">
        {!convite ? (
          <form className="ad-login__panel" onSubmit={consultar}>
            <h1 className="ad-login__title">Aceitar convite</h1>
            <p className="ad-workspace__texto">
              Cole abaixo o código de convite que você recebeu de quem administra o Oria.
            </p>
            <Field label="Código do convite">
              <Input
                required
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(ev) => setToken(ev.target.value)}
              />
            </Field>
            <Button type="submit" block disabled={enviando || !token.trim()}>
              Continuar
            </Button>
            <p className="ad-login__erro" role="alert">{erro}</p>
          </form>
        ) : (
          <form className="ad-login__panel" onSubmit={aceitar}>
            <h1 className="ad-login__title">Aceitar convite</h1>
            <p className="ad-workspace__texto">
              Convite para <strong>{convite.email}</strong>
              {convite.organizationNome ? <> entrar em <strong>{convite.organizationNome}</strong></> : null} como{' '}
              {papelLegivel}.
            </p>

            {outraConta && (
              <Callout tone="warning">
                Você está nesta máquina como <strong>{convite.autenticadoComo}</strong>. Este convite é de outro
                e-mail — saia desta conta para continuar.
              </Callout>
            )}
            {precisaEntrar && (
              <Callout tone="info">
                Este e-mail já tem conta no Oria. Entre nela e volte a esta página para aceitar o convite. Sua senha
                não é alterada pelo convite.
              </Callout>
            )}

            {!convite.autenticadoComo && !convite.contaExistente && (
              <>
                <Field label="Seu nome (opcional)">
                  <Input autoComplete="name" value={nome} onChange={(ev) => setNome(ev.target.value)} />
                </Field>
                <Field label="Defina sua senha" hint="Ao menos 12 caracteres.">
                  <Input
                    type="password"
                    required
                    minLength={12}
                    autoComplete="new-password"
                    value={senha}
                    onChange={(ev) => setSenha(ev.target.value)}
                  />
                </Field>
              </>
            )}

            {outraConta ? (
              <Button type="button" block variant="secondary" onClick={() => { logout(); }}>
                Sair de {convite.autenticadoComo}
              </Button>
            ) : precisaEntrar ? (
              <Button type="button" block onClick={() => window.location.assign('/admin')}>
                Ir para o login
              </Button>
            ) : (
              <Button type="submit" block disabled={enviando || (!mesmaConta && senha.length < 12)}>
                {mesmaConta ? 'Aceitar convite' : 'Criar conta e entrar'}
              </Button>
            )}

            <Button
              type="button"
              block
              variant="ghost"
              onClick={() => { setConvite(null); setErro(''); setSenha(''); }}
            >
              Usar outro código
            </Button>
            <p className="ad-login__erro" role="alert">{erro}</p>
          </form>
        )}
      </main>
    </div>
  );
}
