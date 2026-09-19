'use strict';

// Rodada "features × connectors × capabilities" — §26 (testes de classificação), §27 (connector),
// §28 (controles negativos) do comando principal, e §25/§26/§27/§28 do complemento de criativos.
//
// O que estes testes provam:
//
//   1. o vocabulário comercial só tem capacidade comercial do Oria;
//   2. `catalog`, `exchanges` e `refunds` estão EM TRANSIÇÃO: já classificadas como connector
//      capability, ainda conferidas como entitlement — e enquanto estiverem, continuam no
//      vocabulário E no eixo de feature, porque tirá-las antes da fiação é perder o guard;
//   3. os quatro modos do Gerador NÃO são mais feature comercial, e continuam existindo como
//      module capability de `creative_generator` — esses SAÍRAM de verdade, porque o runtime
//      deles já migrou;
//   4. conexão ≠ entitlement: connector conectado não concede feature, feature ligada não
//      conecta connector, e os dois módulos nem se importam;
//   5. o registry de connector não promete capability que o código não tem;
//   6. Tenant #1 não perde acesso a nada nesta migração de modelagem.
//
// Nenhum teste aqui toca banco nem rede: é tudo registry e função pura.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');
const ent = require('../../lib/platform/entitlements.js');
const rotas = require('../../lib/platform/feature-routes.js');
const cc = require('../../lib/platform/connector-capabilities.js');
const mc = require('../../lib/creative-core/module-capabilities.js');
const flags = require('../../lib/creative-core/flags.js');

const PERFIL_TENANT1 = path.join(h.RAIZ_REPO, 'config', 'entitlements', 'tenant1-entitlements.json');

// ── 1. Classificação: o que É feature comercial ──────────────────────────────────────────────

// O que o Oria vende hoje. Sobrevive à troca do fornecedor — é esse o critério (§2).
const FEATURES_COMERCIAIS = [
  'whatsapp', 'instagram', 'advancedAutomations', 'financial', 'creative_generator',
  'meta_ads', 'google_ads', 'analytics_ga4',
];
// Já classificadas como capacidade do connector, ainda no vocabulário porque o runtime confere.
const EM_TRANSICAO = ['catalog', 'exchanges', 'refunds'];

test('classificação · o vocabulário é o comercial mais o que ainda não terminou de migrar', () => {
  assert.deepEqual([...ent.FEATURES].sort(), [...FEATURES_COMERCIAIS, ...EM_TRANSICAO].sort());

  // §26/§4: estas continuam features porque sobrevivem à troca do fornecedor.
  for (const f of ['financial', 'creative_generator', 'whatsapp', 'meta_ads', 'google_ads', 'analytics_ga4']) {
    assert.ok(ent.FEATURES.includes(f), `${f} precisa continuar sendo feature comercial`);
  }
});

test('classificação · catalog, exchanges e refunds ficam declaradas como transição, não como pronto', () => {
  for (const f of EM_TRANSICAO) {
    // Continuam no vocabulário: é o que impede o 403 em tela que funciona hoje.
    assert.ok(ent.FEATURES.includes(f), `${f} saiu do vocabulário antes de o runtime migrar`);
    assert.ok(!ent.FEATURES_DEPRECIADAS[f], `${f} está em transição e não pode ser tratada como já removida`);
    // E ficam com a condição de saída escrita, para ninguém apagar achando que é limpeza.
    assert.match(ent.FEATURES_EM_TRANSICAO[f], /^connector_capability: /);
    assert.match(ent.FEATURES_EM_TRANSICAO[f], /sai quando/);
  }
});

test('classificação · enquanto a chave estiver em transição, a rota continua exigindo a feature', () => {
  // O par é o invariante: chave no vocabulário ⇔ rota no eixo de feature. Quebrar um lado sem o
  // outro é justamente o erro — chave sem rota é plano que não protege nada, rota sem chave é 403.
  const porRota = new Set(rotas.ROTAS.map(([, f]) => f));
  for (const f of EM_TRANSICAO) {
    assert.ok(porRota.has(f), `${f} está no vocabulário e nenhuma rota a exige`);
  }
  assert.equal(rotas.featureDaRota('/api/admin/produtos'), 'catalog');
  assert.equal(rotas.featureDaRota('/api/admin/trocas'), 'exchanges');
  assert.equal(rotas.featureDaRota('/api/admin/reembolsos'), 'refunds');
});

test('classificação · os quatro modos de criativos não são mais feature comercial', () => {
  for (const f of Object.keys(mc.CHAVES_LEGADAS)) {
    assert.ok(!ent.FEATURES.includes(f), `${f} não pode estar no vocabulário comercial`);
    assert.match(ent.FEATURES_DEPRECIADAS[f], /^module_capability: creative_generator\//);
  }
});

test('classificação · toda chave depreciada aponta para um destino que existe de verdade', () => {
  for (const [chave, destino] of Object.entries(ent.FEATURES_DEPRECIADAS)) {
    assert.ok(!ent.FEATURES.includes(chave), `${chave} está depreciada e no vocabulário ao mesmo tempo`);
    if (destino.startsWith('connector_capability: ')) {
      const alvos = destino.slice('connector_capability: '.length).split(', ');
      for (const alvo of alvos) {
        assert.ok(cc.CAPABILITIES.includes(alvo), `${chave} aponta para ${alvo}, que não existe no registry de connector`);
      }
    } else {
      const alvo = destino.replace('module_capability: creative_generator/', '');
      assert.ok(mc.CAPABILITIES.includes(alvo), `${chave} aponta para o modo ${alvo}, que não existe no módulo`);
    }
  }
});

test('classificação · pedir uma feature reclassificada nega (não concede por compatibilidade)', async () => {
  // O plano de uma Organization antiga ainda pode ter a chave gravada como `true`. Ela é ruído.
  const planoAntigo = async () => ({ catalog: true, exchanges: true, refunds: true, creative_clean_angles: true, financial: true });
  for (const f of Object.keys(ent.FEATURES_DEPRECIADAS)) {
    await assert.rejects(
      () => ent.checkEntitlement(planoAntigo, f),
      /feature desconhecida/,
      `${f} não pode ser concedida por estar gravada no plano antigo`
    );
  }
  assert.equal(await ent.checkEntitlement(planoAntigo, 'financial'), true);

  // E o plano efetivo mostrado para a UI nem devolve as chaves antigas.
  const efetivo = await ent.planoEfetivo(planoAntigo);
  assert.deepEqual(Object.keys(efetivo).sort(), [...ent.FEATURES].sort());
});

// ── 2. Rotas: cada uma em exatamente um eixo ─────────────────────────────────────────────────

test('classificação · toda rota tem guard: nenhuma sai do eixo de feature sem entrar em outro', () => {
  // A regressão que este teste existe para pegar: mover a rota para ROTAS_CAPABILITY (que ainda
  // não está ligada em server.js) e tirá-la de ROTAS. O resultado seria uma rota sem verificação
  // de eixo nenhum — mais permissiva do que antes, com cara de faxina.
  const caminhos = [
    '/api/admin/produtos', '/api/admin/produto-tipos', '/api/admin/categorias',
    '/api/admin/category-assignments/preview', '/api/admin/category-jobs/1',
    '/api/admin/agrupamentos', '/api/admin/promocoes', '/api/admin/estoque',
    '/api/admin/controle-estoque', '/api/admin/trocas', '/api/admin/reembolsos',
  ];
  for (const c of caminhos) {
    assert.ok(rotas.featureDaRota(c), `${c} ficou sem guard de feature antes de a fiação existir`);
    assert.ok(rotas.capabilityDaRota(c), `${c} precisa ter o destino de capability declarado`);
  }
});

test('classificação · a sobreposição dos dois eixos é exatamente o conjunto em transição', () => {
  // Quando a fiação chegar, cada rota destas sai de ROTAS e a sobreposição some. Enquanto isso,
  // NENHUMA rota comercial pode aparecer no eixo de capability.
  const comerciais = ['/api/admin/financeiro', '/api/admin/whatsapp/fila', '/api/admin/criativos/gerar'];
  for (const c of comerciais) {
    assert.ok(rotas.featureDaRota(c), `${c} perdeu o guard comercial`);
    assert.equal(rotas.capabilityDaRota(c), null, `${c} é capacidade do Oria e não pode depender de connector`);
  }
  assert.equal(rotas.featureDaRota('/api/admin/financeiro'), 'financial');
  assert.equal(rotas.featureDaRota('/api/admin/whatsapp/fila'), 'whatsapp');
  assert.equal(rotas.featureDaRota('/api/admin/criativos/gerar'), 'creative_generator');

  const sobrepostas = rotas.ROTAS
    .filter(([re]) => rotas.capabilityDaRota(exemplo(re)) !== null)
    .map(([, f]) => f);
  assert.deepEqual([...new Set(sobrepostas)].sort(), [...EM_TRANSICAO].sort(),
    'só o conjunto em transição pode estar nos dois eixos');
});

// Um caminho concreto que casa com o padrão, para perguntar ao outro eixo.
function exemplo(re) {
  const amostras = [
    '/api/admin/financeiro', '/api/admin/whatsapp/fila', '/api/admin/criativos/gerar',
    '/api/admin/reembolsos', '/api/admin/trocas', '/api/admin/produtos', '/api/admin/estoque',
  ];
  return amostras.find((c) => re.test(c)) || '/nada';
}

test('classificação · toda rota do eixo comercial aponta para feature do vocabulário, e vice-versa', () => {
  for (const [, f] of rotas.ROTAS) assert.ok(ent.FEATURES.includes(f), `rota exige ${f}, fora do vocabulário`);
  for (const [, c] of rotas.ROTAS_CAPABILITY) assert.ok(cc.CAPABILITIES.includes(c), `rota exige ${c}, fora do registry de connector`);
  // Nenhuma rota de capability pode reusar uma chave comercial (§34).
  for (const [, c] of rotas.ROTAS_CAPABILITY) assert.ok(c.includes('.'), `${c} precisa ser namespaced por provider`);
});

// ── 3. Connector Ink: registry honesto ───────────────────────────────────────────────────────

test('connector · o registry da Ink só marca como suportada capability com evidência no código', () => {
  const ink = cc.PROVIDERS.ink.capabilities;
  for (const [nome, def] of Object.entries(ink)) {
    assert.ok(cc.ESTADOS.includes(def.estado), `${nome}: estado inválido`);
    assert.ok(def.rotulo, `${nome}: sem rótulo para a tela`);
    if (def.estado === cc.PLANEJADA) {
      assert.equal(def.evidencia, null, `${nome} é planejada e não pode ter evidência`);
    } else {
      assert.ok(def.evidencia, `${nome} é ${def.estado} e precisa citar a evidência no código`);
    }
    if (def.estado === cc.DERIVADA) {
      assert.ok(Array.isArray(def.derivadaDe) && def.derivadaDe.length, `${nome}: derivada precisa dizer de quê`);
      for (const base of def.derivadaDe) assert.ok(ink[base], `${nome}: deriva de ${base}, que não existe`);
    }
  }
});

test('connector · produção, envio e importação de produtos NÃO estão disponíveis (o código não faz)', () => {
  // Auditoria do código: não há endpoint de produção, não há etiqueta/fulfilment, e importar a
  // estampa para dentro do Oria é dívida futura (Artwork Vault), não capacidade de hoje.
  for (const nome of ['production', 'shipping', 'product_import']) {
    assert.equal(cc.PROVIDERS.ink.capabilities[nome].estado, cc.PLANEJADA, `${nome} não pode ser anunciada como suportada`);
    assert.equal(cc.capabilityDisponivel(`ink.${nome}`, { conectado: true }), false,
      `${nome} não pode ficar disponível nem com o connector conectado`);
  }
});

test('connector · estoque e rastreamento são derivados, não capacidade nativa da Ink', () => {
  assert.equal(cc.PROVIDERS.ink.capabilities.inventory.estado, cc.DERIVADA);
  assert.equal(cc.PROVIDERS.ink.capabilities.tracking.estado, cc.DERIVADA);
  // Derivada continua sendo operacional — o painel entrega estoque hoje.
  assert.equal(cc.capabilityDisponivel('ink.inventory', { conectado: true }), true);
});

test('connector · Ink desconectada: capabilities existem no registry, mas nada fica disponível', () => {
  const desconectado = cc.readModel('ink', { conectado: false });
  assert.equal(desconectado.connected, false);
  assert.deepEqual(desconectado.capabilities, [], 'desconectado não disponibiliza nada');
  assert.ok(desconectado.suportadas.length > 0, 'o registry continua existindo para a tela prometer o que vem depois');
  for (const c of cc.CAPABILITIES) {
    assert.equal(cc.capabilityDisponivel(c, { conectado: false }), false, `${c} disponível sem connector`);
  }
});

test('connector · Ink conectada: só as suportadas/derivadas ficam disponíveis', () => {
  const conectado = cc.readModel('ink', { conectado: true });
  assert.equal(conectado.connected, true);
  const esperadas = cc.capabilitiesDoProvider('ink', { estados: cc.ESTADOS_OPERACIONAIS });
  assert.deepEqual([...conectado.capabilities].sort(), [...esperadas].sort());
  for (const p of conectado.planejadas) {
    assert.ok(!conectado.capabilities.includes(p), `${p} é planejada e apareceu como disponível`);
  }
  // O read model é o de §32: provider + connected + capabilities.
  assert.deepEqual(Object.keys(conectado).sort(), ['capabilities', 'connected', 'planejadas', 'provider', 'rotulo', 'suportadas']);
});

test('connector · capability desconhecida é erro, nunca false silencioso', () => {
  assert.throws(() => cc.definicao('ink.teletransporte'), cc.CapabilityDesconhecidaError);
  assert.throws(() => cc.definicao('printful.orders'), cc.CapabilityDesconhecidaError);
  assert.throws(() => cc.definicao('orders'), cc.CapabilityDesconhecidaError);
  assert.throws(() => cc.capabilityDisponivel('ink.', { conectado: true }), cc.CapabilityDesconhecidaError);
});

test('connector · o guard não consulta o provider e nega quando a leitura de conexão falha', async () => {
  const chamadas = [];
  const guard = cc.requireCapability(async (provider) => { chamadas.push(provider); throw new Error('sem segredo'); }, 'ink.exchanges');
  const res = resposta();
  await guard({}, res, () => { throw new Error('não podia seguir'); });
  assert.equal(res.status_, 409);
  assert.deepEqual(res.json_, { erro: 'connector_nao_conectado', provider: 'ink', capability: 'exchanges' });
  assert.deepEqual(chamadas, ['ink'], 'leu a conexão local uma vez; nunca falou com a Ink');
});

test('connector · desconectado responde 409 identificável, nunca 403 genérico (§22)', async () => {
  const guard = cc.requireCapability(async () => false, 'ink.products');
  const res = resposta();
  await guard({}, res, () => { throw new Error('não podia seguir'); });
  assert.equal(res.status_, 409, 'a tela precisa distinguir "conecte a Ink" de "não está no plano"');
  assert.notEqual(res.status_, 403);
  assert.equal(res.json_.erro, 'connector_nao_conectado');

  // Conectado passa.
  let seguiu = false;
  await cc.requireCapability(async () => true, 'ink.products')({}, resposta(), () => { seguiu = true; });
  assert.equal(seguiu, true);
});

test('connector · capability planejada responde "não suportada", mesmo conectado', async () => {
  const guard = cc.requireCapability(async () => true, 'ink.production');
  const res = resposta();
  await guard({}, res, () => { throw new Error('não podia seguir'); });
  assert.equal(res.status_, 501);
  assert.equal(res.json_.erro, 'capability_nao_suportada');
});

// ── 4. Conexão ≠ entitlement (§13) ───────────────────────────────────────────────────────────

test('§13 · connector conectado não concede feature nenhuma', async () => {
  const planoVazio = async () => ({});
  const conectado = cc.readModel('ink', { conectado: true });
  assert.ok(conectado.capabilities.includes('products'));
  // Mesmo com tudo conectado, o plano continua mandando no eixo comercial.
  for (const f of ent.FEATURES) {
    await assert.rejects(() => ent.checkEntitlement(planoVazio, f), /ausente no plano/, `${f} foi concedida pela conexão`);
  }
});

test('§13 · feature ligada não conecta connector nenhum', () => {
  const planoCheio = Object.fromEntries(ent.FEATURES.map((f) => [f, true]));
  assert.ok(Object.values(planoCheio).every((v) => v === true));
  // A conexão é um booleano que vem da integração da Organization; o plano não entra na conta.
  assert.equal(cc.readModel('ink', { conectado: false }).capabilities.length, 0);
  assert.equal(cc.capabilityDisponivel('ink.exchanges', { conectado: false }), false);
});

test('§13 · os dois registries não se importam (a separação é estrutural, não convenção)', () => {
  const fonteCc = fs.readFileSync(path.join(h.RAIZ_REPO, 'lib', 'platform', 'connector-capabilities.js'), 'utf8');
  const fonteEnt = fs.readFileSync(path.join(h.RAIZ_REPO, 'lib', 'platform', 'entitlements.js'), 'utf8');
  assert.ok(!/require\(['"][^'"]*entitlements['"]\)/.test(fonteCc), 'o registry de connector importou entitlements');
  assert.ok(!/require\(['"][^'"]*connector-capabilities['"]\)/.test(fonteEnt), 'o registry de features importou connector');
  // E a função de disponibilidade ignora plano: sua única entrada que conta é `conectado`.
  assert.equal(cc.capabilityDisponivel('ink.exchanges', { financial: true, creative_generator: true }), false,
    'um plano cheio não pode disponibilizar capability de um connector desconectado');
  assert.equal(cc.capabilityDisponivel('ink.exchanges', {}), false);
});

// ── 5. Criativos: uma feature, quatro module capabilities ────────────────────────────────────

test('criativos · o módulo tem as quatro capabilities e nenhuma delas é feature de plano', () => {
  assert.deepEqual([...mc.CAPABILITIES], ['clean_angles', 'remarketing', 'funnel_visual', 'multi_product']);
  assert.equal(mc.FEATURE_DO_MODULO, 'creative_generator');
  assert.ok(ent.FEATURES.includes('creative_generator'));
  for (const c of mc.CAPABILITIES) {
    assert.ok(!ent.FEATURES.includes(c), `${c} virou feature comercial`);
    assert.ok(!ent.FEATURES.includes(`creative_${c}`), `creative_${c} voltou ao vocabulário comercial`);
    assert.ok(mc.ROTULO[c], `${c} sem rótulo`);
  }
});

test('criativos · creative_generator=true libera todos os modos V1; false não libera nenhum', () => {
  const ligado = flags.resolveFlags({ creative_generator: true }, '');
  assert.deepEqual(flags.enabledEngines(ligado).sort(), ['CLEAN_ANGLES', 'FUNNEL_VISUAL', 'REMARKETING']);
  assert.equal(flags.checkEngineAccess(ligado, 'CLEAN_ANGLES', 'single_product'), null);
  assert.equal(flags.checkEngineAccess(ligado, 'FUNNEL_VISUAL', 'single_product'), null);
  assert.equal(flags.checkEngineAccess(ligado, 'REMARKETING', 'multi_product'), null, 'multipeça vem junto com o módulo');
  assert.deepEqual(mc.capabilitiesDisponiveis(true), [...mc.CAPABILITIES]);

  const desligado = flags.resolveFlags({}, '');
  assert.deepEqual(flags.enabledEngines(desligado), []);
  assert.match(flags.checkEngineAccess(desligado, 'CLEAN_ANGLES', 'single_product'), /gerador de criativos não está habilitado/);
  assert.deepEqual(mc.capabilitiesDisponiveis(false), []);
});

test('criativos · as chaves antigas no plano não ligam nem desligam mais nada', () => {
  // Plano antigo, com os quatro modos gravados e o módulo DESLIGADO: nada liga.
  const soModos = flags.resolveFlags({
    creative_clean_angles: true, creative_remarketing: true, creative_funnel_visual: true, creative_multi_product: true,
  }, '');
  assert.deepEqual(flags.enabledEngines(soModos), [], 'modo ligado sem o módulo não pode valer nada');

  // Plano antigo com o módulo ligado e um modo explicitamente FALSE: o modo continua disponível,
  // porque o eixo comercial por engine deixou de existir.
  const moduloComModoFalse = flags.resolveFlags({ creative_generator: true, creative_funnel_visual: false }, '');
  assert.equal(flags.checkEngineAccess(moduloComModoFalse, 'FUNNEL_VISUAL', 'single_product'), null);
});

test('criativos · o escape hatch de env liga o módulo, não motores avulsos', () => {
  const soEngineNaEnv = flags.resolveFlags({}, 'creative_clean_angles');
  assert.deepEqual(flags.enabledEngines(soEngineNaEnv), [], 'env não pode ligar motor sem o módulo');
  const moduloNaEnv = flags.resolveFlags({}, 'creative_generator');
  assert.deepEqual(flags.enabledEngines(moduloNaEnv).sort(), ['CLEAN_ANGLES', 'FUNNEL_VISUAL', 'REMARKETING']);
});

// ── 6. Migração sem regressão (§20) ──────────────────────────────────────────────────────────

test('§20 · o Tenant #1 não perde acesso a nada: cada área removida tem um caminho novo', () => {
  const perfil = JSON.parse(fs.readFileSync(PERFIL_TENANT1, 'utf8'));
  assert.deepEqual(perfil.features, ['catalog', 'creative_generator', 'exchanges', 'financial', 'refunds', 'whatsapp']);
  for (const f of perfil.features) assert.ok(ent.FEATURES.includes(f), `${f} fora do vocabulário`);

  // Antes: as dez do perfil antigo. Cada uma das sete que saíram continua acessível.
  const ANTES = [
    'catalog', 'creative_clean_angles', 'creative_funnel_visual', 'creative_generator',
    'creative_multi_product', 'creative_remarketing', 'exchanges', 'financial', 'refunds', 'whatsapp',
  ];
  const conectado = cc.readModel('ink', { conectado: true });
  const modos = mc.capabilitiesDisponiveis(perfil.features.includes('creative_generator'));

  for (const antiga of ANTES) {
    if (perfil.features.includes(antiga)) continue; // continua como feature comercial
    const destino = ent.FEATURES_DEPRECIADAS[antiga];
    assert.ok(destino, `${antiga} sumiu do perfil sem destino declarado`);
    if (destino.startsWith('connector_capability: ')) {
      for (const alvo of destino.slice('connector_capability: '.length).split(', ')) {
        const { capability } = cc.separar(alvo);
        assert.ok(conectado.capabilities.includes(capability),
          `${antiga} → ${alvo} não fica disponível nem com a Ink conectada: isso seria regressão`);
      }
    } else {
      assert.ok(modos.includes(destino.replace('module_capability: creative_generator/', '')),
        `${antiga} perdeu acesso: o modo não vem mais do módulo`);
    }
  }
});

test('§20 · o perfil do Tenant #1 só declara feature com guard de rota', () => {
  const perfil = JSON.parse(fs.readFileSync(PERFIL_TENANT1, 'utf8'));
  for (const f of perfil.features) assert.equal(ent.ESTADO_DAS_FEATURES[f], 'implementada', `${f} não está implementada`);
  assert.ok(!perfil.features.includes('instagram'));
  assert.ok(!perfil.features.includes('advancedAutomations'));
});

// ── 7. Controles negativos (§28) ─────────────────────────────────────────────────────────────
//
// Ciclo de 3 passos sobre CÓPIAS dos registries: [1] passa no estado correto, [3] a violação
// reprova, [5] volta a passar. Sem isso, um teste que só afirma o estado atual não prova que
// reprovaria a regressão.

const { pathToFileURL } = require('node:url');
const os = require('node:os');

// Copia o módulo para uma pasta temporária que espelha `lib/platform` (symlink dos vizinhos e do
// node_modules), aplica a violação e devolve o caminho. Sem o espelho, o `require` relativo do
// módulo copiado não resolveria e o controle negativo "passaria" pelo motivo errado.
function copiaComViolacao(t, arquivoRelativo, de, para) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-cap-nc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origem = path.join(h.RAIZ_REPO, arquivoRelativo);
  const original = fs.readFileSync(origem, 'utf8');
  assert.equal(original.split(de).length - 1, 1, `trecho da violação não encontrado em ${arquivoRelativo}`);
  const base = path.basename(arquivoRelativo);
  for (const vizinho of fs.readdirSync(path.dirname(origem))) {
    if (vizinho === base) continue;
    fs.symlinkSync(path.join(path.dirname(origem), vizinho), path.join(dir, vizinho));
  }
  fs.symlinkSync(path.join(h.RAIZ_REPO, 'node_modules'), path.join(dir, 'node_modules'));
  const destino = path.join(dir, base);
  fs.writeFileSync(destino, original.replace(de, para));
  return { destino, original, dir };
}

// Ciclo de 3 passos sobre um invariante: [1] o módulo real passa, [3] a cópia violada reprova,
// [5] o módulo real continua passando.
function ciclo(invariante, real, violado, nome) {
  assert.doesNotThrow(() => invariante(real), `[1] o estado correto já reprovava: ${nome}`);
  assert.throws(() => invariante(violado), /AssertionError/, `[3] a violação passou: ${nome}`);
  assert.doesNotThrow(() => invariante(real), `[5] o invariante não voltou a passar: ${nome}`);
}

const SEM_MOTOR_NO_PLANO = (m) => {
  for (const f of ['creative_clean_angles', 'creative_remarketing', 'creative_funnel_visual', 'creative_multi_product']) {
    assert.ok(!m.FEATURES.includes(f), `${f} é modo interno e voltou como feature de plano`);
  }
};

// §12 — o invariante que protege a ordem da migração: enquanto `requireEntitlement` conferir a
// chave, ela precisa existir no vocabulário E no plano. Tirar de um dos dois lugares antes de o
// consumidor runtime migrar não é reclassificação: é 403 em tela que funciona.
const GUARD_TEM_CHAVE = (m) => {
  for (const [, f] of rotas.ROTAS) {
    assert.ok(m.FEATURES.includes(f), `a rota exige ${f}, que saiu do vocabulário: seria 403 em tela que funciona`);
  }
};

test('negative control · motor de criativos voltar como checkbox de plano reprova', (t) => {
  const { destino } = copiaComViolacao(t, 'lib/platform/entitlements.js',
    "  'refunds',\n]);",
    "  'refunds',\n  'creative_multi_product', // VIOLAÇÃO DELIBERADA — \"o Pro só vende multipeça\"\n]);");
  ciclo(SEM_MOTOR_NO_PLANO, ent, require(destino), 'modo interno como feature de plano');
});

test('negative control · §12 · tirar do vocabulário uma chave que a rota ainda exige reprova', (t) => {
  // A violação é a tentadora: "catalog virou capability, então some com ela". O guard da rota
  // continua conferindo `catalog`, e chave fora de FEATURES é negada como desconhecida.
  const { destino } = copiaComViolacao(t, 'lib/platform/entitlements.js',
    "  'catalog',\n  'exchanges',",
    "  // VIOLAÇÃO DELIBERADA — \"já é connector capability, não precisa mais estar aqui\"\n  'exchanges',");
  ciclo(GUARD_TEM_CHAVE, ent, require(destino), 'chave removida com o guard ainda ligado');
});

// A mesma regra do outro lado da fronteira: o plano `internal` é declarado no control plane, e
// tirar de lá uma chave que a rota exige tem o mesmo efeito. Aqui a checagem é textual porque o
// arquivo é de outro app — não dá para `require` a cópia sem o node_modules dele.
const PLANO_INTERNAL = path.join(h.RAIZ_REPO, '..', 'platform-admin', 'lib', 'entitlements.js');
const chavesDoInternal = (fonte) =>
  [...fonte.match(/const FEATURES_INTERNAL = Object\.freeze\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);

const PLANO_COBRE_O_GUARD = (fonte) => {
  const noPlano = chavesDoInternal(fonte);
  for (const [, f] of rotas.ROTAS) {
    assert.ok(noPlano.includes(f), `a rota exige ${f} e o plano internal não concede: 403 imediato`);
  }
};

test('negative control · §12 · tirar do plano internal uma chave que a rota ainda exige reprova', () => {
  const original = fs.readFileSync(PLANO_INTERNAL, 'utf8');
  // O par é único dentro de FEATURES_INTERNAL (a lista é alfabética); em FEATURES, `catalog` vem
  // depois de `analytics_ga4`. Sem essa âncora, a violação cairia na lista errada e o controle
  // passaria pelo motivo errado.
  const de = "  'catalog',\n  'creative_generator',";
  assert.equal(original.split(de).length - 1, 1, 'trecho da violação não encontrado — o controle não aplicaria nada');
  const violado = original.replace(de, "  // VIOLAÇÃO DELIBERADA — \"catalog é capability agora\"\n  'creative_generator',");
  ciclo(PLANO_COBRE_O_GUARD, original, violado, 'chave tirada do plano com o guard ainda ligado');
});

test('negative control · Ink desconectada devolvendo 403 genérico reprova', async (t) => {
  const { destino } = copiaComViolacao(t, 'lib/platform/connector-capabilities.js',
    "      res.status(409).json({ erro: 'connector_nao_conectado', provider: def.provider, capability: def.capability });",
    "      res.status(403).json({ erro: 'feature_nao_disponivel' }); // VIOLAÇÃO DELIBERADA — \"403 já existe, reaproveita\"");
  const violado = require(destino);
  const res = resposta();
  await violado.requireCapability(async () => false, 'ink.exchanges')({}, res, () => {});
  assert.equal(res.status_, 403, 'a cópia precisa mesmo carregar a violação');
  assert.throws(
    () => { assert.equal(res.status_, 409); assert.equal(res.json_.erro, 'connector_nao_conectado'); },
    /AssertionError/,
    'a violação passou: desconectado virou 403 genérico e a tela não consegue oferecer "conectar"'
  );
  // [5] o registry real continua distinguindo.
  const bom = resposta();
  await cc.requireCapability(async () => false, 'ink.exchanges')({}, bom, () => {});
  assert.equal(bom.status_, 409);
});

test('negative control · financial ou creative_generator dependendo da Ink reprova', () => {
  // A dependência seria estrutural: o registry comercial passando a importar o de connector, ou
  // a rota comercial passando a exigir capability. Nenhuma das duas pode existir.
  const fonteEnt = fs.readFileSync(path.join(h.RAIZ_REPO, 'lib', 'platform', 'entitlements.js'), 'utf8');
  assert.ok(!/require\([^)]*connector-capabilities/.test(fonteEnt), 'entitlements passou a depender do connector');

  const fonteFlags = fs.readFileSync(path.join(h.RAIZ_REPO, 'lib', 'creative-core', 'flags.js'), 'utf8');
  assert.ok(!/require\([^)]*(connector-capabilities|integrations)/.test(fonteFlags), 'o Gerador passou a depender da Ink');
  assert.ok(!/inkApi/.test(fonteFlags), 'o Gerador passou a chamar a Ink');

  for (const [, f] of rotas.ROTAS) {
    assert.ok(!f.includes('.'), `a rota comercial ${f} passou a exigir capability de provider`);
  }
  // E o gerador continua ligando com a Ink ausente.
  const semInk = flags.resolveFlags({ creative_generator: true }, '');
  assert.equal(flags.checkEngineAccess(semInk, 'CLEAN_ANGLES', 'multi_product'), null);
});

// ── 8. A migration desta rodada é aditiva (expand → contract) ───────────────────────────────
//
// O pre-deploy roda a migration ENQUANTO a release antiga ainda atende. Uma migration que apaga o
// que o código antigo lê tira acesso na janela do deploy — e, se a release nova falhar depois de
// migrar, tira por tempo indeterminado. A ordem é sempre: primeiro a release que para de ler a
// chave, depois a migration que a apaga, em outra rodada. A 0024 já foi escrita uma vez com o
// DELETE junto; este teste existe para a segunda vez não acontecer sem que alguém decida de
// propósito.
const MIGRATION_0024 = path.join(h.RAIZ_REPO, 'migrations', 'sql', '0024-composicao-do-internal.up.sql');
const semComentarios = (sql) => sql.replace(/--.*$/gm, '');

const MIGRATION_ADITIVA = (sql) => {
  const codigo = semComentarios(sql);
  assert.ok(!/\bDELETE\s+FROM\b/i.test(codigo),
    'a migration apaga linha: a remoção física é uma migration de limpeza separada, depois do deploy');
  assert.ok(!/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE)\b/i.test(codigo), 'a migration remove estrutura ou esvazia tabela');
  assert.ok(!/\bUPDATE\s+(plan_features|organization_entitlement_overrides)\b/i.test(codigo),
    'a migration reescreve entitlement existente');
};

test('migration · a 0024 é aditiva: nada é apagado enquanto a release antiga ainda pode estar no ar', () => {
  const original = fs.readFileSync(MIGRATION_0024, 'utf8');
  MIGRATION_ADITIVA(original);
  // O caso concreto que motivou o teste: apagar os quatro modos de criativos que o código de
  // produção ainda lê do plano.
  const violado = `${original}\nDELETE FROM plan_features WHERE feature::text IN ('creative_clean_angles', 'creative_multi_product');\n`;
  assert.notEqual(violado, original);
  ciclo(MIGRATION_ADITIVA, original, violado, 'DELETE de chave que a release antiga ainda lê');
});

// Resposta Express mínima, só o que os guards usam.
function resposta() {
  const res = { status_: null, json_: null };
  res.status = (c) => { res.status_ = c; return res; };
  res.json = (o) => { res.json_ = o; return res; };
  return res;
}
