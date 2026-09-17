import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { Button, Field, Input } from '../components/ds';

// Login individual (Fase 2): e-mail + senha. E-mail em branco só serve para o login legado de
// emergência, que o servidor aceita apenas com ALLOW_LEGACY_ADMIN_PASSWORD=1.
export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    setError('');
    setLoading(true);
    login(email, password).catch((err: Error) => {
      setError(err.message);
      setLoading(false);
    });
  }

  return (
    <div className="ad-login-root">
      <main className="ad-login">
        <form className="ad-login__panel" onSubmit={handleSubmit}>
          <h1 className="ad-login__title">Admin · Orgulho Regional</h1>
          <Field label="E-mail">
            <Input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
            />
          </Field>
          <Button type="submit" block disabled={loading}>
            Entrar
          </Button>
          <p className="ad-login__erro" role="alert">
            {error}
          </p>
        </form>
      </main>
    </div>
  );
}
