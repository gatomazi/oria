// Estado de autenticação da UI.
//
// A UI **não lê cookie**: o cookie de sessão é HttpOnly e host-only (contrato §4.1). O único jeito
// de saber se há sessão é perguntar a `GET /api/platform/auth/session`. Este módulo guarda o que
// aquela rota devolveu — em memória, e só enquanto a aba viver.

let admin = null;

export function definirAdmin(novo) {
  admin = novo || null;
}

export function adminAtual() {
  return admin;
}

export function autenticado() {
  return admin !== null;
}

export function ehOwner() {
  return !!admin && admin.papel === 'platform_owner';
}

// Gate de renderização: o backend recusa com 403 `papel_insuficiente` de qualquer jeito (a
// autoridade é dele). Esconder o botão é honestidade de interface, não segurança.
export function podeGerirPlataforma() {
  return ehOwner();
}
