'use strict';

// Tela do app — só conversa com o processo principal pela ponte `window.app` (preload.js).
const $ = (id) => document.getElementById(id);
const CAMPOS_NUMERICOS = ['esperaDesktopSeg', 'esperaNavegadorSeg', 'ociosoSeg', 'loteAntesPausa', 'pausaMinSeg', 'pausaMaxSeg', 'pausaLongaMinSeg', 'pausaLongaMaxSeg'];

const SITUACAO = {
  pausado: { label: 'Pausado', classe: 'badge--neutro' },
  iniciando: { label: 'Iniciando', classe: 'badge--info' },
  enviando: { label: 'Enviando', classe: 'badge--sucesso' },
  aguardando: { label: 'Ativo', classe: 'badge--info' },
  testando: { label: 'Testando', classe: 'badge--info' },
  erro: { label: 'Atenção', classe: 'badge--erro' },
};

const FALHA = {
  numero_invalido: 'número inválido',
  app_nao_abriu: 'WhatsApp não ficou em primeiro plano',
  interrompido: 'computador em uso durante o envio',
};

function mostrarMsg(id, texto, erro = false) {
  const el = $(id);
  el.textContent = texto || '';
  el.classList.toggle('msg--erro', erro);
}

function renderEstado(estado) {
  if (!estado) return;
  // Teste e erro aparecem mesmo com o envio da fila pausado.
  const prioritario = estado.situacao === 'testando' || estado.situacao === 'erro';
  const info = estado.pausado && !prioritario ? SITUACAO.pausado : SITUACAO[estado.situacao] || SITUACAO.aguardando;
  const badge = $('badge-situacao');
  badge.textContent = info.label;
  badge.className = `badge ${info.classe}`;
  $('detalhe').textContent = estado.detalhe || '';
  $('enviadas').textContent = String(estado.enviadosSessao || 0);
  $('falhas').textContent = String(estado.falhasSessao || 0);
  $('ultimo').textContent = estado.ultimoEnvioEm
    ? new Date(estado.ultimoEnvioEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '—';
  $('btn-iniciar').hidden = !estado.pausado;
  $('btn-pausar').hidden = estado.pausado;
}

async function carregarConfig() {
  const cfg = await window.app.obterConfig();
  $('painel-url').value = cfg.painelUrl || '';
  $('token-status').textContent = cfg.tokenConfigurado ? '(configurado)' : '(não configurado)';
  document.querySelectorAll('input[name="modo"]').forEach((el) => { el.checked = el.value === cfg.modo; });
  CAMPOS_NUMERICOS.forEach((campo) => { $(campo).value = cfg[campo]; });
  $('iniciarComSistema').checked = !!cfg.iniciarComSistema;
}

async function iniciar() {
  const info = await window.app.info();
  $('versao').textContent = `v${info.versao}`;
  if (!info.suportado) mostrarMsg('msg-envio', 'Sistema não suportado (só macOS e Windows).', true);
  $('card-permissao').hidden = info.plataforma !== 'darwin' || info.acessibilidade;
  $('permissao-dev').hidden = info.empacotado;
  // Rodando pelo `npm start` o sistema não deixa registrar item de início.
  $('iniciarComSistema').disabled = !info.empacotado;
  $('dica-inicio').hidden = info.empacotado;

  await carregarConfig();
  renderEstado(await window.app.obterEstado());
  window.app.aoMudarEstado(renderEstado);

  $('btn-iniciar').addEventListener('click', async () => {
    mostrarMsg('msg-envio', '');
    const r = await window.app.iniciar();
    if (r.erro) mostrarMsg('msg-envio', r.erro, true);
  });
  $('btn-pausar').addEventListener('click', () => window.app.pausar());

  $('btn-permissao').addEventListener('click', async () => {
    const r = await window.app.pedirPermissao();
    $('card-permissao').hidden = r.acessibilidade;
  });
  $('btn-permissao-verificar').addEventListener('click', async () => {
    const atual = await window.app.info();
    $('card-permissao').hidden = atual.acessibilidade;
    if (!atual.acessibilidade) mostrarMsg('msg-envio', 'A permissão ainda não foi liberada. Se acabou de ligar, feche e abra o app de novo.', true);
  });

  $('btn-salvar-conexao').addEventListener('click', async () => {
    mostrarMsg('msg-conexao', '');
    const r = await window.app.salvarConfig({ painelUrl: $('painel-url').value.trim() });
    if (r.erro) return mostrarMsg('msg-conexao', r.erro, true);
    const token = $('token').value.trim();
    if (token) {
      const t = await window.app.salvarToken(token);
      if (t.erro) return mostrarMsg('msg-conexao', t.erro, true);
      $('token').value = '';
      if (t.aviso) mostrarMsg('msg-conexao', t.aviso, true);
    }
    await carregarConfig();
    if (!document.getElementById('msg-conexao').textContent) mostrarMsg('msg-conexao', 'Conexão salva.');
  });

  $('btn-salvar-config').addEventListener('click', async () => {
    mostrarMsg('msg-config', '');
    const modo = document.querySelector('input[name="modo"]:checked');
    const dados = { modo: modo ? modo.value : 'desktop', iniciarComSistema: $('iniciarComSistema').checked };
    CAMPOS_NUMERICOS.forEach((campo) => { dados[campo] = Number($(campo).value); });
    const r = await window.app.salvarConfig(dados);
    if (r.erro) return mostrarMsg('msg-config', r.erro, true);
    $('iniciarComSistema').checked = !!r.config.iniciarComSistema;
    if (r.aviso) return mostrarMsg('msg-config', `Ajustes salvos. ${r.aviso}`, true);
    mostrarMsg('msg-config', 'Ajustes salvos.');
  });

  $('btn-testar').addEventListener('click', async () => {
    mostrarMsg('msg-teste', 'Enviando… não mexa no computador por alguns segundos (se uma mensagem da fila estiver saindo, o teste entra logo depois).');
    $('btn-testar').disabled = true;
    try {
      const r = await window.app.testar($('telefone-teste').value);
      if (r.erro) mostrarMsg('msg-teste', r.erro, true);
      else if (r.status === 'sent') mostrarMsg('msg-teste', 'Enter enviado. Confira se a mensagem chegou no WhatsApp.');
      else mostrarMsg('msg-teste', `Falhou: ${FALHA[r.codigo] || r.detalhe || r.codigo}`, true);
    } finally {
      $('btn-testar').disabled = false;
    }
  });
}

iniciar();
