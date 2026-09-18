'use strict';

// Aceite do convite de owner emitido pelo control plane (Oria Admin · §3.6 e §15 de
// docs/architecture/control-plane.md).
//
// O control plane EMITE o convite e devolve o token cru UMA vez. Quem consome é o Tenant Plane —
// é aqui que a pessoa define a senha e entra. Desenho e alternativas descartadas:
// docs/architecture/invite-acceptance.md.
//
// ── O que o token prova ──────────────────────────────────────────────────────────────────────
// O token é um opaco de 256 bits em base64url, gerado pelo control plane
// (`crypto.randomBytes(32).toString('base64url')`). No banco existe só o SHA-256 em hex. Aqui o
// token recebido é convertido pelo MESMO algoritmo — `sha256(token)` hex minúsculo, idêntico ao
// `sha256` de apps/platform-admin/lib/organizations.js — e o que viaja para o Postgres é o hash.
// Nenhuma comparação de texto com o que veio do cliente, nenhum `SELECT … WHERE token = $1`.
//
// ── Quem aceita ──────────────────────────────────────────────────────────────────────────────
// A IDENTIDADE é o e-mail do convite, lido do banco — nunca do corpo do request:
//
//   e-mail sem conta   → o aceite CRIA a conta com a senha definida agora
//   e-mail com conta   → o aceite exige uma sessão AUTENTICADA daquela conta (login normal antes)
//
// O aceite nunca redefine a senha de uma conta existente: "tem token, então troca a senha" é
// exatamente o jeito de tomar a conta de outra pessoa. E uma sessão autenticada de OUTRO e-mail
// não aceita o convite: o token não transfere o convite para quem estiver logado.
//
// ── O que o convidado vê quando falha ────────────────────────────────────────────────────────
// `platform_convite_pendente` devolve `desconhecido | usado | revogado | expirado`. Os QUATRO dão
// a MESMA resposta (404 + `convite_invalido` + a mesma frase). Quem tenta não distingue "nunca
// existiu" de "já foi usado". O motivo real vai para o log do servidor — sem o token, e sem o
// hash inteiro.

const crypto = require('crypto');

const senhas = require('./password');
const { CONFIG_ORGANIZATION } = require('../platform/tenant-db');

// Formato do token emitido pelo control plane: 32 bytes em base64url = 43 caracteres.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PAPEIS = new Set(['owner', 'member']);
const CAMPOS_ACEITE = new Set(['token', 'senha', 'nome']);
const CAMPOS_CONSULTA = new Set(['token']);

// Uma frase para os quatro motivos de falha. Muda aqui, muda em tudo.
const MENSAGEM_GENERICA = 'convite inválido, expirado ou já usado';

const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

// Identificação do convite em log e em balde de rate limit. NUNCA o token, e nem o hash inteiro:
// o hash é o que está gravado no banco, e um log com ele é um log com a chave da linha.
const referencia = (hash) => hash.slice(0, 12);

class ConviteError extends Error {
  constructor(codigo, status, message, { motivo = null } = {}) {
    super(message);
    this.name = 'ConviteError';
    this.codigo = codigo;
    this.status = status;
    // Só para o log do servidor. Nunca vai para a resposta.
    this.motivo = motivo;
  }
}

function conviteInvalido(motivo) {
  return new ConviteError('convite_invalido', 404, MENSAGEM_GENERICA, { motivo });
}

// Token malformado nem chega ao banco — e responde igual a um token que não existe.
function hashDoToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw conviteInvalido('formato');
  return sha256(token);
}

function corpoLimpo(corpo, permitidos) {
  const c = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
  const extras = Object.keys(c).filter((k) => !permitidos.has(k));
  if (extras.length) {
    throw new ConviteError('campos_nao_aceitos', 400, `campos não aceitos: ${extras.join(', ')}`);
  }
  return c;
}

function createInviteService({ pool, sessoes, agora = () => new Date() }) {
  if (!pool) throw new Error('createInviteService exige o pool do Postgres');
  if (!sessoes) throw new Error('createInviteService exige o store de sessões');

  // Abre a transação do aceite. A Organization só entra no contexto DEPOIS de sair do convite —
  // é o banco que diz qual é, nunca o request. De lá para a frente vale o mesmo mecanismo de
  // `comOrganization`: `set_config(app.current_organization_id, …, true)`, local à transação, com
  // a RLS forçada valendo como em qualquer outra escrita do painel.
  async function naTransacao(fn) {
    const client = await pool.connect();
    let descartar = false;
    try {
      await client.query('BEGIN');
      const resultado = await fn(client, async (organizationId) => {
        await client.query('SELECT set_config($1, $2, true)', [CONFIG_ORGANIZATION, organizationId]);
      });
      await client.query('COMMIT');
      return resultado;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { descartar = true; });
      throw err;
    } finally {
      client.release(descartar);
    }
  }

  // Leitura que NÃO consome, com a linha travada até o fim da transação (0020). Qualquer motivo
  // diferente de `ok` vira a mesma falha genérica.
  async function pendente(client, hash) {
    const { rows: [c] } = await client.query('SELECT * FROM platform_convite_pendente($1)', [hash]);
    if (!c || c.motivo !== 'ok') throw conviteInvalido(c ? c.motivo : 'sem_resposta');
    if (!PAPEIS.has(c.papel)) throw new ConviteError('convite_invalido', 404, MENSAGEM_GENERICA, { motivo: 'papel' });
    return c;
  }

  async function usuarioPorEmail(client, email) {
    const { rows } = await client.query('SELECT id, email, status FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  }

  // ── Consulta (não consome) ─────────────────────────────────────────────────────────────────
  // Existe para a tela saber QUAL formulário mostrar: "defina sua senha" ou "entre na conta que já
  // existe". Só responde a quem já tem o token — e, para qualquer token que não seja um convite
  // pendente, responde exatamente como a rota de aceite.
  async function consultar({ corpo, auth = null }) {
    const { token } = corpoLimpo(corpo, CAMPOS_CONSULTA);
    const hash = hashDoToken(token);
    return naTransacao(async (client, comOrganizacao) => {
      const c = await pendente(client, hash);
      const existente = await usuarioPorEmail(client, c.email);
      await comOrganizacao(c.organization_id);
      const { rows: [org] } = await client.query(
        `SELECT nome, status FROM organizations WHERE id = $1`, [c.organization_id]
      );
      return {
        email: c.email,
        papel: c.papel,
        organizationNome: org ? org.nome : null,
        // Diz à tela se ela pede senha nova ou pede login. Não revela senha, id nem status.
        contaExistente: !!existente,
        // Quem está logado neste navegador agora (se alguém estiver). A tela usa para oferecer
        // "sair desta conta" quando a sessão aberta é de outra pessoa.
        autenticadoComo: auth ? auth.email : null,
      };
    });
  }

  // ── Aceite ─────────────────────────────────────────────────────────────────────────────────
  // Uma transação: ler o convite (travando a linha) → resolver/criar a pessoa → consumir →
  // membership → auditoria. Qualquer falha desfaz tudo, inclusive o consumo: o convite volta a
  // valer e a pessoa pode tentar de novo.
  async function aceitar({ corpo, auth = null }) {
    const { token, senha, nome } = corpoLimpo(corpo, CAMPOS_ACEITE);
    const hash = hashDoToken(token);

    if (auth && senha !== undefined) {
      // Sessão aberta + senha no corpo seria "redefinir a senha com um token". Não existe.
      throw new ConviteError('senha_nao_aceita', 400,
        'você já está autenticado — o aceite não define nem altera a senha desta conta');
    }

    // scrypt custa ~100 ms e ~32 MB: fica FORA da transação, para não segurar a trava do convite.
    // A senha só é validada aqui; quem decide se ela será usada é o ramo "conta nova" lá embaixo.
    let senhaHash = null;
    if (!auth) {
      try {
        senhas.validarSenhaNova(senha);
      } catch (err) {
        throw new ConviteError('senha_invalida', 400, err.message);
      }
      senhaHash = await senhas.gerarHash(senha);
    }

    const nomePessoa = typeof nome === 'string' && nome.trim() ? nome.trim().slice(0, 200) : null;

    const resultado = await naTransacao(async (client, comOrganizacao) => {
      const c = await pendente(client, hash);
      const existente = await usuarioPorEmail(client, c.email);

      let userId;
      let criou = false;
      if (auth) {
        // A identidade é o e-mail do CONVITE. Uma sessão de outra conta não o aceita — senão o
        // token viraria um jeito de dar acesso a quem estiver logado no navegador.
        if (auth.email !== c.email) {
          throw new ConviteError('convite_de_outra_conta', 403,
            'este convite é de outro e-mail — saia desta conta e aceite com o e-mail convidado');
        }
        userId = auth.userId;
      } else if (existente) {
        // Conta já existe: nada de criar, nada de trocar senha. Autentica primeiro, aceita depois.
        throw new ConviteError('conta_existente', 409,
          'este e-mail já tem conta no Oria — entre nela e aceite o convite de novo');
      } else {
        const { rows: [u] } = await client.query(
          'INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id, email',
          [c.email, nomePessoa, senhaHash]
        ).catch((err) => {
          // Corrida com um cadastro do mesmo e-mail entre a leitura e o INSERT: a transação
          // inteira desfaz e o convite continua pendente.
          if (err.code === '23505') {
            throw new ConviteError('conta_existente', 409,
              'este e-mail já tem conta no Oria — entre nela e aceite o convite de novo');
          }
          throw err;
        });
        userId = u.id;
        criou = true;
      }

      const { rows: [consumo] } = await client.query(
        'SELECT * FROM platform_consumir_convite($1, $2)', [hash, userId]
      );
      // A linha está travada desde `pendente`: só chega aqui com `ok`. Qualquer outra coisa é
      // integridade, não fluxo — e desfaz tudo.
      if (!consumo || consumo.motivo !== 'ok') throw conviteInvalido(consumo ? consumo.motivo : 'sem_resposta');

      // Daqui para baixo, a Organization do CONVITE é o contexto. Toda escrita passa pela RLS.
      await comOrganizacao(consumo.organization_id);

      const { rows: [org] } = await client.query(
        `SELECT nome, status FROM organizations WHERE id = $1`, [consumo.organization_id]
      );
      // Organization suspensa ou apagada: `auth_memberships` só devolve as ativas, então o
      // membership nasceria invisível e a pessoa entraria sem workspace. Recusa e devolve o
      // convite (ROLLBACK) — o convite continua valendo quando a Organization voltar.
      if (!org || org.status !== 'active') {
        throw new ConviteError('organization_indisponivel', 409,
          'esta organization não está disponível no momento — fale com quem enviou o convite');
      }

      const inserido = await client.query(
        `INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING papel`,
        [consumo.organization_id, userId, consumo.papel]
      );
      const jaEraMembro = inserido.rowCount === 0;

      await client.query(
        `INSERT INTO audit_log (criado_em, actor_user_id, action, entity_type, entity_id, loja, before, after, organization_id)
         VALUES ($1, $2, 'org.invite.accept', 'user', $3::text, NULL, 'null'::jsonb, $4::jsonb, $5::uuid)`,
        [
          agora().toISOString(), userId, userId,
          // Sem token, sem hash, sem senha: só o que a auditoria precisa para explicar o vínculo.
          JSON.stringify({ conviteId: consumo.convite_id, papel: consumo.papel, contaCriada: criou, jaEraMembro }),
          consumo.organization_id,
        ]
      );

      return {
        userId,
        email: consumo.email,
        papel: consumo.papel,
        organizationId: consumo.organization_id,
        organizationNome: org.nome,
        contaCriada: criou,
      };
    });

    // A sessão vive fora da transação do aceite: ela não pode ser desfeita por um ROLLBACK do
    // membership, e um COMMIT do membership não pode depender de gravar sessão.
    let sessao = null;
    if (auth) {
      // Já autenticado: a sessão atual continua, só passa a apontar para a Organization nova. É o
      // mesmo UPDATE do POST /session/organization, e o valor vem do banco, não do navegador.
      await pool.query('UPDATE sessions SET active_organization_id = $1 WHERE id = $2',
        [resultado.organizationId, auth.sessaoId]);
    } else {
      // `metodo` é o vocabulário fechado de `sessions` ('senha' | 'legado', CHECK da 0011). A
      // sessão nasce de uma senha que a pessoa acabou de definir nesta mesma request — é sessão de
      // senha, e não vale alterar o CHECK de uma tabela viva só para renomear isso. Quem quiser
      // saber que ela veio de um convite lê o `org.invite.accept` da auditoria.
      sessao = await sessoes.criar({ userId: resultado.userId, metodo: 'senha' });
      await pool.query('UPDATE sessions SET active_organization_id = $1 WHERE id = $2',
        [resultado.organizationId, sessao.id]);
      await pool.query('UPDATE users SET ultimo_login_em = now() WHERE id = $1', [resultado.userId]);
    }
    return { ...resultado, sessao };
  }

  return { consultar, aceitar };
}

module.exports = {
  MENSAGEM_GENERICA,
  TOKEN_RE,
  ConviteError,
  sha256,
  referencia,
  createInviteService,
};
