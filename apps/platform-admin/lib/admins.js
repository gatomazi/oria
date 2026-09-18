'use strict';

// Platform admins: identidade, login e gestão (§7, §8, §9).
//
// Invariante central: **sempre existe um `platform_owner` com status `active`**. Ele é conferido
// em dois lugares, de propósito:
//
//   1. aqui, dentro da transação da mutação, para dar um 409 legível;
//   2. no banco, por trigger, para que esquecer (1) um dia ainda assim não derrube a plataforma.
//
// Nunca há e-mail hardcoded. O primeiro admin nasce do script de bootstrap, com valores que o
// usuário informa.

const { gerarHash, verificarSenha, hashDeReferencia, validarSenhaNova, SenhaInvalidaError } = require('./password');
const { emTransacao } = require('./db');
const audit = require('./audit');
const { HttpError, erro404, erro409, erro422 } = require('./http');

const PAPEIS = Object.freeze(['platform_owner', 'platform_operator']);

function paraApi(linha) {
  return {
    id: linha.id,
    email: linha.email,
    nome: linha.nome,
    papel: linha.papel,
    status: linha.status,
    criadoEm: linha.criado_em,
    ultimoLoginEm: linha.ultimo_login_em,
  };
}

function criarServicoDeAdmins({ pool, sessoes, limiter, agora = () => new Date() }) {
  async function existeAlgum() {
    const { rows } = await pool.query(`SELECT 1 FROM platform_admins WHERE status = 'active' LIMIT 1`);
    return rows.length > 0;
  }

  // Autenticação. Três casos — e-mail inexistente, senha errada, admin desativado — devolvem
  // EXATAMENTE a mesma resposta, e o caso "inexistente" paga o mesmo custo de scrypt (hash de
  // referência). A resposta nunca revela se o e-mail está cadastrado.
  async function login({ email, senha, manterOutrasSessoes = false }) {
    if (!(await existeAlgum())) {
      throw new HttpError(503, 'bootstrap_pendente',
        'nenhum platform admin cadastrado — rode `npm run platform-admin:bootstrap`');
    }
    if (limiter.bloqueado(email)) {
      const err = new HttpError(429, 'rate_limited', 'muitas tentativas; tente de novo mais tarde');
      err.cabecalhos = { 'Retry-After': String(limiter.esperaEmSegundos(email)) };
      throw err;
    }

    const { rows } = await pool.query(
      'SELECT id, email, nome, papel, status, password_hash FROM platform_admins WHERE email = $1',
      [email]
    );
    const admin = rows[0];
    const hash = admin && admin.status === 'active' ? admin.password_hash : await hashDeReferencia();
    const senhaConfere = await verificarSenha(senha, hash);

    if (!admin || admin.status !== 'active' || !senhaConfere) {
      limiter.registrarFalha(email);
      // Tentativa falha é registrada com o sujeito que temos: se o admin existe, o id dele; se não
      // existe, não há sujeito real e a auditoria (que exige sujeito) não é chamada — o rastro
      // desse caso é o log do processo, sem o e-mail tentado.
      if (admin) {
        await emTransacao(pool, (c) => audit.registrar(c, {
          ator: { adminId: admin.id, email: admin.email },
          action: 'admin.login_failed',
          entityType: 'platform_admin',
          entityId: admin.id,
          after: { status: admin.status },
        })).catch((err) => console.error(`[AUTH] falha ao auditar login negado: ${err.message}`));
      } else {
        console.warn('[AUTH] login negado para e-mail não cadastrado');
      }
      throw new HttpError(401, 'credenciais_invalidas', 'e-mail ou senha inválidos');
    }

    limiter.registrarSucesso(email);
    const sessao = await sessoes.criar({ adminId: admin.id });

    // Fixation: a sessão é sempre NOVA (id gerado no servidor) e, por padrão, as anteriores do
    // mesmo admin são revogadas. `manterOutrasSessoes` é escolha explícita de quem entra.
    if (!manterOutrasSessoes) {
      await sessoes.revogarDoAdmin(admin.id, { por: admin.id, motivo: 'login', exceto: sessao.id });
    }
    await emTransacao(pool, async (c) => {
      await c.query('UPDATE platform_admins SET ultimo_login_em = now() WHERE id = $1', [admin.id]);
      await audit.registrar(c, {
        ator: { adminId: admin.id, email: admin.email },
        action: 'admin.login',
        entityType: 'platform_admin',
        entityId: admin.id,
      });
    });

    return {
      sessao,
      admin: { id: admin.id, email: admin.email, nome: admin.nome, papel: admin.papel },
    };
  }

  async function logout(auth) {
    await emTransacao(pool, async (c) => {
      await c.query(
        `UPDATE platform_admin_sessions SET revogada_em = now(), revogada_por = $2, motivo_revogacao = 'logout'
          WHERE id = $1 AND revogada_em IS NULL`,
        [auth.sessaoId, auth.adminId]
      );
      await audit.registrar(c, {
        ator: { adminId: auth.adminId, email: auth.email },
        action: 'admin.logout',
        entityType: 'platform_admin',
        entityId: auth.adminId,
      });
    });
  }

  async function listar({ limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      `SELECT id, email, nome, papel, status, criado_em, ultimo_login_em
         FROM platform_admins
        WHERE ($1::timestamptz IS NULL OR (criado_em, id) < ($1, $2))
        ORDER BY criado_em DESC, id DESC
        LIMIT $3`,
      [cursor ? cursor.em : null, cursor ? cursor.id : null, limite + 1]
    );
    return { rows, paraApi };
  }

  async function criar({ ator, email, nome, senha, papel }) {
    try {
      validarSenhaNova(senha);
    } catch (err) {
      if (err instanceof SenhaInvalidaError) throw erro422('senha_fraca', err.message, { minimo: 12 });
      throw err;
    }
    const hash = await gerarHash(senha);
    return emTransacao(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO platform_admins (email, nome, password_hash, papel)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, nome, papel, status, criado_em, ultimo_login_em`,
        [email, nome, hash, papel]
      ).catch((err) => {
        if (err.code === '23505') throw erro409('email_em_uso', 'já existe um platform admin com este e-mail');
        throw err;
      });
      const novo = rows[0];
      await audit.registrar(c, {
        ator,
        action: 'admin.created',
        entityType: 'platform_admin',
        entityId: novo.id,
        after: { email: novo.email, papel: novo.papel, status: novo.status },
      });
      return paraApi(novo);
    });
  }

  // `destino`: 'disabled' | 'active'. O trigger do banco é a rede; o 409 aqui é a mensagem.
  async function mudarStatus({ ator, adminId, destino }) {
    return emTransacao(pool, async (c) => {
      const { rows } = await c.query(
        'SELECT id, email, nome, papel, status, criado_em, ultimo_login_em FROM platform_admins WHERE id = $1 FOR UPDATE',
        [adminId]
      );
      const alvo = rows[0];
      if (!alvo) throw erro404();
      if (alvo.status === destino) return paraApi(alvo);

      if (destino === 'disabled') {
        const { rows: [{ n }] } = await c.query('SELECT platform_admin_owners_ativos() AS n');
        if (alvo.papel === 'platform_owner' && alvo.status === 'active' && n <= 1) {
          throw erro409('ultimo_platform_owner', 'o último platform_owner ativo não pode ser desativado');
        }
      }

      const { rows: [novo] } = await c.query(
        `UPDATE platform_admins SET status = $2, atualizado_em = now() WHERE id = $1
         RETURNING id, email, nome, papel, status, criado_em, ultimo_login_em`,
        [adminId, destino]
      ).catch(traduzirUltimoOwner);

      if (destino === 'disabled') {
        await c.query(
          `UPDATE platform_admin_sessions SET revogada_em = now(), revogada_por = $2, motivo_revogacao = 'admin_desativado'
            WHERE admin_id = $1 AND revogada_em IS NULL`,
          [adminId, ator.adminId]
        );
      }

      await audit.registrar(c, {
        ator,
        action: destino === 'disabled' ? 'admin.deactivated' : 'admin.reactivated',
        entityType: 'platform_admin',
        entityId: adminId,
        before: { status: alvo.status },
        after: { status: novo.status },
      });
      return paraApi(novo);
    });
  }

  async function mudarPapel({ ator, adminId, papel }) {
    return emTransacao(pool, async (c) => {
      const { rows } = await c.query(
        'SELECT id, email, nome, papel, status, criado_em, ultimo_login_em FROM platform_admins WHERE id = $1 FOR UPDATE',
        [adminId]
      );
      const alvo = rows[0];
      if (!alvo) throw erro404();
      if (alvo.papel === papel) return paraApi(alvo);

      if (alvo.papel === 'platform_owner' && alvo.status === 'active') {
        const { rows: [{ n }] } = await c.query('SELECT platform_admin_owners_ativos() AS n');
        if (n <= 1) throw erro409('ultimo_platform_owner', 'o último platform_owner ativo não pode ser rebaixado');
      }

      const { rows: [novo] } = await c.query(
        `UPDATE platform_admins SET papel = $2, atualizado_em = now() WHERE id = $1
         RETURNING id, email, nome, papel, status, criado_em, ultimo_login_em`,
        [adminId, papel]
      ).catch(traduzirUltimoOwner);

      await audit.registrar(c, {
        ator,
        action: 'admin.role_changed',
        entityType: 'platform_admin',
        entityId: adminId,
        before: { papel: alvo.papel },
        after: { papel: novo.papel },
      });
      return paraApi(novo);
    });
  }

  return { existeAlgum, login, logout, listar, criar, mudarStatus, mudarPapel, paraApi };
}

// O trigger do banco dispara `restrict_violation`; traduzir mantém a mensagem estável para a UI.
function traduzirUltimoOwner(err) {
  if (err.code === '2F004' || /último platform_owner/.test(err.message || '')) {
    throw erro409('ultimo_platform_owner', 'o último platform_owner ativo não pode ser removido nem rebaixado');
  }
  throw err;
}

module.exports = { PAPEIS, criarServicoDeAdmins, paraApi };
