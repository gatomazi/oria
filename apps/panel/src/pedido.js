(function () {
  'use strict';

  var LOGOS = { sul: '/assets/logo-sul.png', centro: '/assets/logo-centro.png', norte: '/assets/logo-norte.png' };
  var app = document.getElementById('app');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function formatValor(valor) {
    if (!valor) return null;
    var n = Number(String(valor).replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function renderErro(msg) {
    app.innerHTML = '';
    app.appendChild(el('div', 'pd-erro', msg));
  }

  function copiarTexto(texto, botao) {
    var onOk = function () {
      var original = botao.dataset.label;
      botao.classList.add('pd-copiado');
      botao.textContent = 'Código copiado!';
      setTimeout(function () {
        botao.classList.remove('pd-copiado');
        botao.textContent = original;
      }, 2200);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(texto).then(onOk).catch(function () { copiarFallback(texto, onOk); });
    } else {
      copiarFallback(texto, onOk);
    }
  }

  function copiarFallback(texto, onOk) {
    var ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); onOk(); } catch (e) { /* silencioso */ }
    document.body.removeChild(ta);
  }

  var PENDENTE_STATUSES = ['pending', 'waiting_payment', 'awaiting_analysis'];
  var PAGO_STATUSES = ['paid', 'succeeded', 'free'];
  var POLL_INTERVAL_MS = 8000;
  var pollTimer = null;

  function isPendente(pedido) {
    return PENDENTE_STATUSES.indexOf(pedido.paymentStatus) !== -1;
  }

  function renderStatusFinal(pedido, body) {
    var pago = PAGO_STATUSES.indexOf(pedido.paymentStatus) !== -1;
    var classe = pago ? 'pd-status pd-status--ok' : 'pd-status pd-status--erro';
    var titulo = pago ? 'Pagamento confirmado!' : (pedido.orderStatusLabel || 'Pix indisponível');
    var sub = pago
      ? 'Recebemos a confirmação do seu pagamento. Seu pedido já está em andamento.'
      : 'Esse código Pix não está mais disponível para pagamento. Fale com quem te enviou o link para gerar um novo.';

    body.appendChild(el('h1', 'pd-titulo', titulo));
    body.appendChild(el('div', classe, pago ? '✓' : '×'));
    body.appendChild(el('p', 'pd-sub', sub));
  }

  function renderPixPendente(pedido, body) {
    var titulo = pedido.cliente ? ('Olá, ' + pedido.cliente + '!') : 'Pagamento via PIX';
    body.appendChild(el('h1', 'pd-titulo', titulo));
    body.appendChild(el('p', 'pd-sub', 'Escaneie o QR Code ou copie o código para pagar seu pedido.'));

    var valorFormatado = formatValor(pedido.valor);
    if (valorFormatado) {
      body.appendChild(el('div', 'pd-valor', valorFormatado));
    }

    var qrWrap = el('div', 'pd-qr-wrap');
    var qrImg = document.createElement('img');
    qrImg.src = pedido.qrImageUrl;
    qrImg.alt = 'QR Code para pagamento PIX';
    qrWrap.appendChild(qrImg);
    body.appendChild(qrWrap);

    body.appendChild(el('div', 'pd-pix-label', 'Pix copia e cola'));
    body.appendChild(el('div', 'pd-pix-box', pedido.pixCode));

    var btn = el('button', 'pd-btn-copy', 'Copiar código Pix');
    btn.type = 'button';
    btn.dataset.label = 'Copiar código Pix';
    btn.addEventListener('click', function () { copiarTexto(pedido.pixCode, btn); });
    body.appendChild(btn);

    var instrucoes = el('div', 'pd-instrucoes');
    instrucoes.innerHTML = '<strong>Como pagar:</strong> abra o app do seu banco, vá em Pix &rarr; Pix Copia e Cola, cole o código copiado acima e confirme. Ou escaneie o QR Code direto na tela de pagamento.';
    body.appendChild(instrucoes);

    var avisoIfood = el('div', 'pd-aviso');
    avisoIfood.innerHTML = '<strong>É normal aparecer "iFood" na identificação do Pix.</strong> Isso acontece porque usamos o iFood Pago como plataforma de pagamentos, da mesma forma que outras lojas usam Mercado Pago, PagSeguro ou outros intermediadores. O pagamento é 100% seguro e, assim que aprovado, seu pedido é confirmado normalmente na loja.';
    body.appendChild(avisoIfood);
  }

  function renderPedido(pedido) {
    app.innerHTML = '';
    app.setAttribute('data-loja', pedido.loja);

    var card = el('div', 'pd-card');

    var header = el('div', 'pd-header');
    var logo = LOGOS[pedido.loja];
    if (logo) {
      var img = document.createElement('img');
      img.src = logo;
      img.alt = pedido.lojaNome || '';
      header.appendChild(img);
    }
    header.appendChild(el('div', 'pd-header__loja', pedido.lojaNome || ''));
    card.appendChild(header);

    var body = el('div', 'pd-body');

    if (pedido.qrImageUrl && pedido.pixCode) {
      renderPixPendente(pedido, body);
    } else {
      renderStatusFinal(pedido, body);
    }

    card.appendChild(body);
    app.appendChild(card);
    app.appendChild(el('div', 'pd-footer', '© Orgulho Regional · pagamento processado diretamente com a loja'));
  }

  // Enquanto o pagamento está pendente e o pedido é acompanhado pela Reserva Ink,
  // consulta o status a cada poucos segundos e atualiza a tela sem recarregar a página.
  function iniciarPolling(id) {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      fetch('/api/pedidos/' + encodeURIComponent(id))
        .then(function (res) {
          if (!res.ok) throw new Error('not found');
          return res.json();
        })
        .then(function (pedido) {
          if (!isPendente(pedido)) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
          renderPedido(pedido);
        })
        .catch(function () { /* falha temporária: mantém a tela atual e tenta de novo no próximo ciclo */ });
    }, POLL_INTERVAL_MS);
  }

  function init() {
    var id = window.location.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!id) { renderErro('Pedido não encontrado.'); return; }

    fetch('/api/pedidos/' + encodeURIComponent(id))
      .then(function (res) {
        if (!res.ok) throw new Error('not found');
        return res.json();
      })
      .then(function (pedido) {
        renderPedido(pedido);
        if (pedido.paymentStatus && isPendente(pedido)) iniciarPolling(id);
      })
      .catch(function () {
        renderErro('Não encontramos esse pedido. Confira o link recebido ou fale com quem te enviou.');
      });
  }

  init();
})();
