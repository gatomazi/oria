'use strict';

// SQL da role da aplicação (TD-001 · OPS-14). Em CI é aplicado por scripts/test-db.mjs; em produção
// é o mesmo SQL, executado pelo operador no passo OPS-14 — não por migration, porque role é objeto do
// cluster e a senha não pode morar no repositório.
//
//   NOSUPERUSER NOBYPASSRLS  a RLS vale para ela
//   NOINHERIT                não herda privilégio de dona por pertencer a outra role
//   só DML nas tabelas sob RLS e nas globais da aplicação (users, sessions, oauth_states), EXECUTE
//   nas funções SECURITY DEFINER abaixo, SELECT em pgmigrations (verificação de boot) e nada nas
//   globais privadas (tenancy_mapeamentos, external_resource_claims, job_leases, onboarding_*)

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

// Funções SECURITY DEFINER que o processo Node chama antes de existir contexto de tenant.
const FUNCOES_DA_APLICACAO = Object.freeze([
  'auth_memberships(UUID)',
  // Entitlement canônico: o painel lê o plano efetivo da Organization do contexto sem receber
  // GRANT nas tabelas comerciais da plataforma (que são globais privadas).
  'entitlements_estado(UUID)',
  'entitlements_efetivos(UUID)',
  'tenancy_organizations_para_jobs()',
  'tenancy_organization_da_loja(TEXT)',
  'tenancy_organization_do_wamid(TEXT)',
  'publico_organization_do_pedido(TEXT)',
  'publico_organization_da_midia(TEXT)',
  'publico_organization_do_agente(TEXT)',
  // Fase 4 · posse de recurso externo, sempre com a Organization do contexto.
  'integracao_reivindicar_recurso(TEXT, TEXT, TEXT)',
  'integracao_liberar_recursos(TEXT, TEXT, TEXT)',
  // Fase 5c · entrada do WhatsApp por (WABA, número).
  'whatsapp_organization_do_remetente(TEXT, TEXT)',
  // Fase 5c · entrada da Ink pela URL opaca (TD-005).
  'ink_organization_do_webhook(TEXT)',
  // Fase 5c · lease persistente dos jobs (TD-006).
  'job_lease_adquirir(TEXT, UUID, TEXT, INTEGER)',
  'job_lease_concluir(TEXT, UUID, TEXT, INTEGER)',
  // Fase 7 · onboarding: reserva da chave de idempotência e convite do primeiro owner. A criação de
  // Organization continua atrás de SECOND_TENANT_ENABLED no serviço (lib/platform/onboarding.js).
  'onboarding_reservar_organizacao(UUID, TEXT, TEXT)',
  'onboarding_emitir_convite(TEXT, TEXT, TIMESTAMPTZ)',
  'onboarding_consumir_convite(TEXT)',
  // Aceite do convite emitido pelo control plane (lib/auth/invites.js). As duas nascem com
  // `REVOKE ALL … FROM PUBLIC` (0019 e 0020) e são o ÚNICO acesso do painel a
  // `organization_owner_invites`, que continua global PRIVADA: a role não lê a tabela, lê a
  // projeção estreita que estas funções devolvem. O par roda na mesma transação — a leitura trava
  // a linha, o consumo a marca.
  'platform_convite_pendente(TEXT)',
  'platform_consumir_convite(TEXT, UUID)',
]);

const { TABELAS_GLOBAIS_DA_APLICACAO, TABELAS_GLOBAIS_PRIVADAS } = require('./tenancy-manifest');

function sqlProvisionarAppRole({
  role, senha, tabelasSobRls, tabelasGlobais = TABELAS_GLOBAIS_DA_APLICACAO, tabelasPrivadas = TABELAS_GLOBAIS_PRIVADAS,
}) {
  if (!ROLE_RE.test(role || '')) throw new Error(`nome de role inválido: ${role}`);
  if (typeof senha !== 'string' || !/^[A-Za-z0-9_-]{12,128}$/.test(senha)) {
    throw new Error('senha da role precisa ter 12-128 caracteres [A-Za-z0-9_-]');
  }
  if (!Array.isArray(tabelasSobRls) || !tabelasSobRls.length) throw new Error('tabelasSobRls vazia');
  for (const t of [...tabelasSobRls, ...tabelasGlobais, ...tabelasPrivadas]) if (!ROLE_RE.test(t)) throw new Error(`tabela inválida: ${t}`);

  const atributos = `LOGIN PASSWORD '${senha}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`;
  return [
    `DO $role$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE ${role} ${atributos};
       ELSE
         ALTER ROLE ${role} ${atributos};
       END IF;
     END $role$;`,
    `GRANT USAGE ON SCHEMA public TO ${role};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${tabelasSobRls.join(', ')} TO ${role};`,
    // Identidade (Fase 2): global por desenho, lida antes do contexto de tenant.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${tabelasGlobais.join(', ')} TO ${role};`,
    ...FUNCOES_DA_APLICACAO.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO ${role};`),
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};`,
    `GRANT SELECT ON pgmigrations TO ${role};`,
    ...tabelasPrivadas.map((t) => `REVOKE ALL ON ${t} FROM ${role};`),
  ];
}

module.exports = { FUNCOES_DA_APLICACAO, sqlProvisionarAppRole };
