/* ═══════════════════════════════════════════════════════════════════
   /LOJA — SPA de personalizados
   Rotas: /{sul|centro|norte}/loja[/produto/[slug]]
   Dados: /data/config.json + /data/produtos.json
   Checkout: gera URL wa.me com mensagem estruturada
   ═══════════════════════════════════════════════════════════════════ */

const REGIOES_LABEL = { sul: 'Use Sul', centro: 'Use Centro', norte: 'Use Norte' };
const REGIOES_TERRITORIO = {
  sul: 'Paraná · Santa Catarina · Rio Grande do Sul',
  centro: 'Goiás · Mato Grosso · Mato Grosso do Sul · Distrito Federal',
  norte: 'Amazonas · Pará · Acre · Rondônia · Roraima · Amapá · Tocantins'
};

const State = {
  regiao: 'sul',
  produtoSlug: null,
  config: null,
  data: null,
  perso: {},
  cor: 'preta',
  tamanho: 'M',
  qtd: 1,
  paleta: null,
  correta: false,
  modoVisual: 'camiseta',  // 'camiseta' | 'closeup'
  editouAlgo: false
};

// ─── BOOT ────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  detectarRegiao();
  aplicarTemaRegiao();
  await carregarDados();
  atualizarTopbar();
  roteamento();
  window.addEventListener('popstate', roteamento);
});

function detectarRegiao() {
  const m = window.location.pathname.match(/^\/(sul|centro|norte)\/loja/);
  State.regiao = m ? m[1] : 'sul';
}

function aplicarTemaRegiao() {
  document.body.setAttribute('data-loja', State.regiao);
  const brand = document.getElementById('brandNome');
  if (brand) brand.textContent = REGIOES_LABEL[State.regiao];
  const brandLink = document.getElementById('brandLink');
  if (brandLink) brandLink.href = `/${State.regiao}/loja`;
  const paletaLoja = { sul: '#4d543d', centro: '#8b5e3c', norte: '#2d4a2b' };
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', paletaLoja[State.regiao]);
}

async function carregarDados() {
  const [cfg, prods] = await Promise.all([
    fetch('/data/config.json').then(r => r.json()),
    fetch('/data/produtos.json').then(r => r.json())
  ]);
  State.config = cfg;
  State.data = prods;
}

function atualizarTopbar() {
  const camp = State.config?.campanhaAtiva;
  if (!camp) return;
  const topbar = document.getElementById('topbar');
  topbar.innerHTML = `<strong>${camp.titulo}</strong> · ${camp.urgencia} · <strong>frete grátis</strong> acima de R$ ${State.config.freteGratis.acima.toFixed(0)}`;
}

// ─── ROTEAMENTO ───────────────────────────────────────────────────
function roteamento() {
  detectarRegiao();
  aplicarTemaRegiao();
  const path = window.location.pathname;
  const mProd = path.match(/^\/(sul|centro|norte)\/loja\/produto\/([^\/]+)/);
  if (mProd) {
    State.produtoSlug = mProd[2];
    renderProduto();
  } else {
    State.produtoSlug = null;
    renderHome();
  }
  window.scrollTo(0, 0);
}

function navegar(caminho) {
  history.pushState({}, '', caminho);
  roteamento();
}

// ─── HOME ────────────────────────────────────────────────────────
function renderHome() {
  const modelos = State.data.modelos;
  const categorias = State.data.categorias;
  const camp = State.config.campanhaAtiva;
  const modelosDiaPais = modelos.filter(m => m.categorias.includes('dia-dos-pais'));

  const depoimentos = [
    { nome: 'Camila R.', avatar: '😊', produto: 'Emblema Raízes · Preta', texto: '"Comprei pro meu pai gaúcho. Quando ele viu o brasão com o ano de nascimento dele, ele não acreditou que era personalizado. Ficou lindo demais!"', estrelas: 5 },
    { nome: 'Lucas T.', avatar: '😎', produto: 'Palavras Coloridas · Bordô', texto: '"A qualidade do algodão peruano é outra coisa. A estampa ficou firme e não desbotou nem depois de várias lavagens. Super recomendo."', estrelas: 5 },
    { nome: 'Fernanda M.', avatar: '🌸', produto: 'Regionalismo Minimal · Mescla cinza', texto: '"Coloquei \'tchê\' na estampa e ficou incrível. Presente perfeito pra quem tem orgulho de ser gaúcho. Atendimento via WhatsApp foi rápido também."', estrelas: 5 },
    { nome: 'Rafael B.', avatar: '🤙', produto: 'Emblema Raízes · Azul marinho', texto: '"Presentei meu avô com o AVÔ. Ele tem 78 anos e ficou emocionado. Valeu cada centavo. Entrega veio antes do prazo!"', estrelas: 5 },
    { nome: 'Juliana O.', avatar: '✨', produto: 'Palavras Coloridas · Verde musgo', texto: '"Comprei 3 iguais pra mim e minhas irmãs com os nossos apelidos de família. Amamos! Já indiquei pra todo mundo."', estrelas: 5 },
    { nome: 'Marcos V.', avatar: '🎯', produto: 'Regionalismo Minimal · Preta', texto: '"Simplesmente perfeito. Design minimalista, algodão de qualidade, e o gentílico regional é exatamente o que eu queria. 10/10."', estrelas: 5 },
  ];

  const html = `
    <section class="lj-urgencia">
      <strong>🎁 ${camp.titulo} — </strong>${camp.urgencia}
      <span class="lj-urgencia__contador">⏰ Últimos dias</span>
    </section>

    <section class="lj-hero">
      <div class="lj-container">
        <p class="lj-hero__eyebrow">${camp.titulo}</p>
        <h1 class="lj-hero__titulo">
          O que o seu pai<br/>mais ama<br/>
          <em>vira presente único.</em>
        </h1>
        <p class="lj-hero__sub">
          Camisetas personalizadas com nome, ano, gentílico ou aquela expressão que só quem é da região entende. Envio para todo o Brasil.
        </p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <button class="lj-btn lj-btn--primary lj-btn--lg" onclick="scrollToId('destaque')">Ver personalizados →</button>
          <div class="lj-stars" style="font-size:13px">
            ${svgStars(5)}
            <span class="lj-stars__count">4,9 · +520 pedidos</span>
          </div>
        </div>
      </div>
    </section>

    <section class="lj-como-funciona">
      <div class="lj-container">
        <p class="lj-secao__eyebrow">Como funciona</p>
        <h2 class="lj-secao__titulo">3 passos, pronto.</h2>
        <div class="lj-passos">
          <div class="lj-passo">
            <div class="lj-passo__num">1</div>
            <h3 class="lj-passo__titulo">Escolha e personalize</h3>
            <p class="lj-passo__desc">Selecione o modelo, coloque o nome, relação, ano ou expressão regional. Preview em tempo real.</p>
          </div>
          <div class="lj-passo">
            <div class="lj-passo__num">2</div>
            <h3 class="lj-passo__titulo">Confirme pelo WhatsApp</h3>
            <p class="lj-passo__desc">Seu pedido já chega pronto na mensagem. É só confirmar, escolher a forma de pagamento e enviar.</p>
          </div>
          <div class="lj-passo">
            <div class="lj-passo__num">3</div>
            <h3 class="lj-passo__titulo">Receba em casa</h3>
            <p class="lj-passo__desc">Produção em 5–7 dias úteis. Frete grátis acima de R$ ${State.config.freteGratis?.acima || 199}. Algodão peruano premium.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="lj-secao" style="padding-top:24px">
      <div class="lj-container">
        <p class="lj-secao__eyebrow">Coleções</p>
        <h2 class="lj-secao__titulo">Escolha por ocasião</h2>
        <div class="lj-colecao-grid">
          ${categorias.map(c => `
            <a href="#cat-${c.slug}" onclick="event.preventDefault();scrollToId('cat-${c.slug}')" class="lj-colecao-card">
              <span class="lj-colecao-card__emoji">${c.emoji}</span>
              <span class="lj-colecao-card__nome">${c.nome}</span>
            </a>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="lj-secao" id="destaque" style="padding-top:32px">
      <div class="lj-container">
        <p class="lj-secao__eyebrow">🎁 ${camp.titulo}</p>
        <h2 class="lj-secao__titulo">Para o melhor pai do mundo.</h2>
        <p class="lj-secao__sub">Modelos personalizáveis com o DNA de quem é da nossa região.</p>
        <div class="lj-produtos-grid">
          ${modelosDiaPais.map(m => cardProduto(m)).join('')}
        </div>
      </div>
    </section>

    <section class="lj-secao" style="padding:32px 0">
      <div class="lj-container">
        <blockquote style="font-family:var(--font-display);font-size:22px;line-height:1.25;max-width:32ch">
          "Seu pai pode ter saído da cidade dele. <em style="color:var(--clay)">Mas a cidade nunca saiu dele.</em>"
        </blockquote>
      </div>
    </section>

    ${categorias.map(cat => {
      const lista = modelos.filter(m => m.categorias.includes(cat.slug));
      if (!lista.length) return '';
      return `
        <section class="lj-secao" id="cat-${cat.slug}">
          <div class="lj-container">
            <p class="lj-secao__eyebrow">${cat.emoji} ${cat.nome}</p>
            <h2 class="lj-secao__titulo">${headlinePorCategoria(cat.slug)}</h2>
            <div class="lj-produtos-grid">
              ${lista.map(m => cardProduto(m)).join('')}
            </div>
          </div>
        </section>
      `;
    }).join('')}

    <section class="lj-depoimentos">
      <div class="lj-container">
        <p class="lj-secao__eyebrow">Depoimentos reais</p>
        <h2 class="lj-secao__titulo">Quem comprou, <em>amou.</em></h2>
        <div class="lj-depo-grid">
          ${depoimentos.map(d => `
            <div class="lj-depo-card">
              <div class="lj-depo-card__header">
                <div class="lj-depo-avatar">${d.avatar}</div>
                <div class="lj-depo-meta">
                  <span class="lj-depo-nome">${d.nome}</span>
                  <span class="lj-depo-produto">${d.produto}</span>
                  <div style="margin-top:3px">${svgStars(d.estrelas)}</div>
                </div>
              </div>
              <p class="lj-depo-texto">${d.texto}</p>
            </div>
          `).join('')}
        </div>
      </div>
    </section>

    <section class="lj-secao" style="text-align:center">
      <div class="lj-container">
        <h2 class="lj-secao__titulo">Não achou o que queria?</h2>
        <p class="lj-secao__sub" style="margin:0 auto 24px">Chama a gente no WhatsApp — se dá pra estampar, a gente faz.</p>
        <a href="${wappUrl('Olá! Quero uma personalização diferente das que vi no site. Podemos conversar?')}" target="_blank" class="lj-btn lj-btn--wapp lj-btn--lg">Chamar no WhatsApp</a>
      </div>
    </section>
  `;
  document.getElementById('app').innerHTML = html;
}

function svgStars(n) {
  const starSvg = '<svg class="lj-stars__icon" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
  return `<div class="lj-stars__icons">${starSvg.repeat(n)}</div>`;
}

function headlinePorCategoria(slug) {
  const map = {
    'dia-dos-pais': 'Para o melhor pai do mundo.',
    'presente': 'Presentes que dizem quem você é.',
    'regionalismo': 'Uma palavra que só quem é dali entende.',
    'familia': 'A família toda em uma estampa.',
    'namorados': 'Amor com sotaque.',
    'copa': 'Torça com identidade.'
  };
  return map[slug] || 'Modelos disponíveis';
}

function cardProduto(m) {
  const preco = precoBase();
  const precoAnterior = (preco * 1.15).toFixed(2).replace('.', ',');
  const dadosEx = exemplo(m);
  const tags = { 'emblema-raizes': 'editorial', 'palavras-coloridas': 'colorido', 'regionalismo-minimal': 'minimal' };
  const avaliacoes = { 'emblema-raizes': { nota: 4.9, total: 80 }, 'palavras-coloridas': { nota: 4.8, total: 63 }, 'regionalismo-minimal': { nota: 5.0, total: 47 } };
  const av = avaliacoes[m.slug] || { nota: 4.9, total: 30 };
  return `
    <a href="/${State.regiao}/loja/produto/${m.slug}" onclick="event.preventDefault();navegar('/${State.regiao}/loja/produto/${m.slug}')" class="lj-produto-card lj-fade-in">
      <div class="lj-produto-card__mockup">
        <span class="lj-produto-card__selo">Personalize</span>
        ${previewEstampa(m, dadosEx, 'escura')}
      </div>
      <div class="lj-produto-card__info">
        <span class="lj-produto-card__tag">— ${tags[m.slug] || 'personalizado'}</span>
        <h3 class="lj-produto-card__nome">${m.nome}</h3>
        <p class="lj-produto-card__sub">${m.subtitulo}</p>
        <div class="lj-produto-card__stars">
          ${svgStars(5)}
          <span>${av.nota} (${av.total})</span>
        </div>
        <div class="lj-produto-card__preco-wrap">
          <span class="lj-produto-card__preco-de">R$ ${precoAnterior}</span>
          <span class="lj-produto-card__preco-por">R$ ${preco.toFixed(2).replace('.', ',')}</span>
        </div>
      </div>
    </a>
  `;
}

function exemplo(modelo) {
  if (modelo.slug === 'emblema-raizes') return { relacao: 'PAI', ano: 1984 };
  if (modelo.slug === 'palavras-coloridas') {
    const gent = modelo.campos.find(c=>c.id==='linha2').sugestoesRegional[State.regiao][0];
    return { linha1: 'MARIDO', linha2: gent, linha3: 'CICLISTA', linha4: 'LENDA', linha5: '', linha6: '' };
  }
  if (modelo.slug === 'regionalismo-minimal') {
    return { expressao: modelo.campos.find(c=>c.id==='expressao').sugestoesRegional[State.regiao][0] };
  }
  return {};
}

// ─── PRODUTO ─────────────────────────────────────────────────────
function renderProduto() {
  const modelo = State.data.modelos.find(m => m.slug === State.produtoSlug);
  if (!modelo) { navegar(`/${State.regiao}/loja`); return; }

  State.perso = {};
  modelo.campos.forEach(c => {
    if (c.tipo === 'select') State.perso[c.id] = c.padrao || c.opcoes[0];
    else if (c.tipo === 'number') State.perso[c.id] = c.padrao;
    else {
      const sug = (c.sugestoesRegional && c.sugestoesRegional[State.regiao]) || c.sugestoes;
      State.perso[c.id] = c.obrigatorio === false ? '' : ((sug && sug[0]) || c.placeholder || '');
    }
  });
  State.cor = State.data.cores[0].slug;
  State.tamanho = 'M';
  State.qtd = 1;
  State.paleta = modelo.paletas ? (modelo.paletaPadrao || modelo.paletas[0].slug) : null;
  State.correta = false;
  State.modoVisual = 'camiseta';

  const camposObrigatorios = modelo.campos.filter(c => c.obrigatorio !== false);
  const camposOpcionais = modelo.campos.filter(c => c.obrigatorio === false);
  const tags = { 'emblema-raizes': 'editorial', 'palavras-coloridas': 'colorido', 'regionalismo-minimal': 'minimal' };

  const avaliacoes = { 'emblema-raizes': { nota: 4.9, total: 80 }, 'palavras-coloridas': { nota: 4.8, total: 63 }, 'regionalismo-minimal': { nota: 5.0, total: 47 } };
  const av = avaliacoes[modelo.slug] || { nota: 4.9, total: 30 };
  const precoAnterior = (precoBase() * 1.15).toFixed(2).replace('.', ',');

  const outrosModelos = State.data.modelos.filter(m => m.slug !== modelo.slug).slice(0, 2);

  const html = `
    <div class="lj-container">
      <button onclick="navegar('/${State.regiao}/loja')" class="lj-detail-back">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 6l-6 6 6 6"/></svg>
        Voltar pra galeria
      </button>

      <div class="lj-detail-grid">
        <!-- COLUNA ESQUERDA: visual -->
        <div>
          <span class="lj-detail-tag">— ${tags[modelo.slug] || 'personalizado'}</span>
          <h1 class="lj-detail-titulo">${modelo.nome}</h1>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <div class="lj-stars">
              ${svgStars(5)}
              <span class="lj-stars__count">${av.nota} (${av.total} avaliações)</span>
            </div>
          </div>
          <p class="lj-detail-sub">${modelo.descricao}</p>

          <div class="lj-detail-visual" data-modo="camiseta" id="produtoVisual">
            <div class="lj-visual-toggle" role="tablist">
              <button class="ativo" data-visual="camiseta" role="tab">Camiseta</button>
              <button data-visual="closeup" role="tab">Closeup</button>
            </div>
            <div class="lj-mockup-wrap" id="mockupWrap"></div>
            <span class="lj-preview-label">Preview em tempo real</span>
          </div>
        </div>

        <!-- COLUNA DIREITA: painel de personalização -->
        <aside class="lj-perso-panel">
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
            <span class="lj-perso-preco__valor" id="precoDetalhe">R$ ${precoBase().toFixed(2).replace('.', ',')}</span>
            <span class="lj-preco-de">R$ ${precoAnterior}</span>
            <span class="lj-desconto-badge">🏷️ 15% OFF</span>
          </div>
          <p style="font-size:11px;color:var(--ink-45);margin:2px 0 0">a unidade · pagamento via PIX, cartão ou boleto</p>

          <div style="border-top:1px solid var(--ink-10);padding-top:16px"></div>

          ${camposObrigatorios.map((c, i) => renderCampo(c, i + 1)).join('')}

          ${camposOpcionais.length ? `
            <details style="border-top:1px dashed var(--ink-15);padding-top:14px">
              <summary style="font-weight:500;cursor:pointer;padding:6px 0;color:var(--clay);font-size:13px">
                + Adicionar linhas (opcional)
              </summary>
              <div style="padding-top:12px;display:flex;flex-direction:column;gap:22px">
                ${camposOpcionais.map((c, i) => renderCampo(c, camposObrigatorios.length + i + 1)).join('')}
              </div>
            </details>
          ` : ''}

          ${modelo.paletas ? renderPaletas(modelo.paletas) : ''}

          <div class="lj-campo">
            <div class="lj-campo__label"><span>Cor da camiseta</span></div>
            <div class="lj-cores" id="coresGrid"></div>
          </div>

          <div class="lj-campo">
            <div class="lj-campo__label">
              <span>Tamanho</span>
              <small><a href="#" onclick="event.preventDefault();alert('P: 96-100cm | M: 100-104cm | G: 104-110cm | GG: 110-116cm | XGG: 116-122cm')" style="color:var(--clay)">Ver tabela</a></small>
            </div>
            <div class="lj-tamanhos" id="tamanhosGrid"></div>
          </div>

          <div class="lj-campo">
            <div class="lj-campo__label"><span>Quantidade</span></div>
            <div class="lj-qtd">
              <button class="lj-qtd__btn" onclick="alterarQtd(-1)" aria-label="Diminuir">−</button>
              <span class="lj-qtd__val" id="qtdVal">1</span>
              <button class="lj-qtd__btn" onclick="alterarQtd(1)" aria-label="Aumentar">+</button>
            </div>
          </div>

          <div class="lj-check-correta lj-check-correta--destaque">
            <input type="checkbox" id="chkCorreta" onchange="State.correta = this.checked; atualizarCTA()">
            <label for="chkCorreta">
              <strong>✅ Minha personalização está CORRETA.</strong><br/>
              <small>Produção sob demanda — não trocamos por erro de digitação.</small>
            </label>
          </div>

          <div>
            <button class="lj-btn lj-btn--wapp lj-btn--lg lj-btn--block" id="ctaBtnDesktop" disabled onclick="abrirModalWapp()">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.05 2c-5.52 0-10 4.48-10 10 0 1.77.46 3.49 1.34 5.01L2 22l5.13-1.35A9.98 9.98 0 0012.05 22c5.52 0 10-4.48 10-10s-4.48-10-10-10zm5.83 14.09c-.24.68-1.43 1.29-1.99 1.34-.5.05-.99.24-3.37-.72-2.86-1.16-4.66-3.99-4.8-4.18-.14-.19-1.14-1.52-1.14-2.9 0-1.38.72-2.06.98-2.34.24-.28.53-.35.7-.35h.5c.16 0 .38-.06.6.46.24.55.78 1.9.85 2.04.07.14.12.31.02.5-.09.19-.14.31-.29.48-.14.16-.31.36-.44.48-.15.14-.3.3-.13.59.17.29.79 1.29 1.69 2.09 1.16 1.03 2.14 1.36 2.44 1.5.3.14.48.12.66-.07.19-.19.76-.88.96-1.19.19-.31.39-.26.66-.15.28.11 1.75.83 2.05.97.3.14.5.22.57.34.08.13.08.76-.16 1.43z"/></svg>
              <span>Confirme os dados</span>
            </button>
          </div>

          <div class="lj-trust-bar">
            <div class="lj-trust-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              Compra segura
            </div>
            <div class="lj-trust-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              Frete grátis ac. R$ ${State.config.freteGratis?.acima || 199}
            </div>
            <div class="lj-trust-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
              5–7 dias úteis
            </div>
            <div class="lj-trust-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
              Algodão peruano
            </div>
          </div>

          <details style="border-top:1px solid var(--ink-10);padding-top:14px">
            <summary style="font-weight:500;cursor:pointer;padding:6px 0;font-size:13px;color:var(--ink-70)">Material & cuidados</summary>
            <div style="font-size:13px;color:var(--ink-60);padding-top:8px;line-height:1.5">
              <p>Algodão fio 30.1 penteado, gramatura 165g/m². Estampa DTG à base d'água — cores firmes, toque macio.</p>
              <p style="margin-top:8px">Lavar do avesso, água fria, sem alvejante.</p>
              <p style="margin-top:8px">Produção sob demanda. Prazo: 5-7 dias úteis + envio.</p>
            </div>
          </details>
        </aside>
      </div>
    </div>

    ${outrosModelos.length ? `
      <div class="lj-relacionados">
        <div class="lj-container">
          <p class="lj-secao__eyebrow">Você também pode gostar</p>
          <h2 class="lj-secao__titulo" style="margin-bottom:20px">Outros modelos</h2>
          <div class="lj-produtos-grid">
            ${outrosModelos.map(m => cardProduto(m)).join('')}
          </div>
        </div>
      </div>
    ` : ''}

    <!-- Sticky CTA (só mobile) -->
    <div class="lj-sticky-cta">
      <div class="lj-sticky-cta__row">
        <div class="lj-sticky-cta__preco">
          <div class="lj-sticky-cta__preco-val" id="ctaTotal">R$ ${precoBase().toFixed(2).replace('.', ',')}</div>
          <div class="lj-sticky-cta__sub" id="ctaSub">1 unid.</div>
        </div>
        <button class="lj-btn lj-btn--wapp lj-btn--lg" id="ctaBtn" disabled onclick="abrirModalWapp()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.05 2c-5.52 0-10 4.48-10 10 0 1.77.46 3.49 1.34 5.01L2 22l5.13-1.35A9.98 9.98 0 0012.05 22c5.52 0 10-4.48 10-10s-4.48-10-10-10zm5.83 14.09c-.24.68-1.43 1.29-1.99 1.34-.5.05-.99.24-3.37-.72-2.86-1.16-4.66-3.99-4.8-4.18-.14-.19-1.14-1.52-1.14-2.9 0-1.38.72-2.06.98-2.34.24-.28.53-.35.7-.35h.5c.16 0 .38-.06.6.46.24.55.78 1.9.85 2.04.07.14.12.31.02.5-.09.19-.14.31-.29.48-.14.16-.31.36-.44.48-.15.14-.3.3-.13.59.17.29.79 1.29 1.69 2.09 1.16 1.03 2.14 1.36 2.44 1.5.3.14.48.12.66-.07.19-.19.76-.88.96-1.19.19-.31.39-.26.66-.15.28.11 1.75.83 2.05.97.3.14.5.22.57.34.08.13.08.76-.16 1.43z"/></svg>
          <span>Confirme</span>
        </button>
      </div>
    </div>
  `;
  document.getElementById('app').innerHTML = html;

  // Bind toggle visual (clique manual pisa qualquer auto-switch)
  document.querySelectorAll('.lj-visual-toggle button').forEach(el => {
    el.addEventListener('click', () => {
      State.modoVisual = el.dataset.visual;
      State.editouAlgo = true; // clique manual conta como intenção — não força mais auto-switch depois
      document.querySelectorAll('.lj-visual-toggle button').forEach(x => x.classList.toggle('ativo', x.dataset.visual === State.modoVisual));
      document.getElementById('produtoVisual').setAttribute('data-modo', State.modoVisual);
      atualizarVisual();
    });
  });

  renderCores();
  renderTamanhos();
  atualizarVisual();
  atualizarCTA();
  bindCamposEventos(modelo);
}

function renderCampo(campo, ordem) {
  const val = State.perso[campo.id];
  const isPrimeiro = ordem === 1;
  const classeBloco = `lj-campo${isPrimeiro ? ' lj-campo--primeiro' : ''}`;
  const numBadge = ordem ? `<span class="lj-campo-num">${ordem}</span>` : '';
  if (campo.tipo === 'select') {
    return `
      <div class="${classeBloco}">
        <div class="lj-campo__label">
          <span class="lj-campo__label-inner">${numBadge}${campo.label}</span>
        </div>
        <select class="lj-select" data-campo="${campo.id}">
          ${campo.opcoes.map(o => `<option value="${o}" ${o === val ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>
    `;
  }
  if (campo.tipo === 'number') {
    return `
      <div class="${classeBloco}">
        <div class="lj-campo__label">
          <span class="lj-campo__label-inner">${numBadge}${campo.label}</span>
        </div>
        <input type="number" class="lj-input" data-campo="${campo.id}"
          min="${campo.min}" max="${campo.max}" value="${val}" placeholder="${campo.placeholder || ''}">
      </div>
    `;
  }
  const sug = (campo.sugestoesRegional && campo.sugestoesRegional[State.regiao]) || campo.sugestoes || [];
  return `
    <div class="${classeBloco}">
      <div class="lj-campo__label">
        <span class="lj-campo__label-inner">${numBadge}${campo.label}</span>
        <small>${(val || '').length}/${campo.maxLength}</small>
      </div>
      <input type="text" class="lj-input" data-campo="${campo.id}"
        maxlength="${campo.maxLength}" value="${val}" placeholder="${campo.placeholder || ''}"
        autocapitalize="characters">
      ${sug.length ? `
        <div class="lj-chips">
          ${sug.map(s => `<button class="lj-chip" data-sug="${campo.id}" data-val="${s}">${s}</button>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderPaletas(paletas) {
  // Se paleta é fixa e só tem uma, apenas mostra as cores (informativo, não editável)
  const unica = paletas.length === 1 && paletas[0].fixa;
  if (unica) {
    const p = paletas[0];
    return `
      <div class="lj-campo">
        <div class="lj-campo__label">
          <span>Paleta da estampa</span>
          <small>fixa</small>
        </div>
        <div class="lj-paletas">
          <div class="lj-paleta lj-paleta--ativa" style="cursor:default">
            <span class="lj-paleta__cores">
              ${p.cores.map(c => `<span class="lj-paleta__c" style="background:${c}"></span>`).join('')}
            </span>
            <span class="lj-paleta__nome">${p.label}</span>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="lj-campo">
      <div class="lj-campo__label"><span>Paleta da estampa</span></div>
      <div class="lj-paletas" id="paletasGrid">
        ${paletas.map(p => `
          <button class="lj-paleta ${p.slug === State.paleta ? 'lj-paleta--ativa' : ''}" data-paleta="${p.slug}">
            <span class="lj-paleta__cores">
              ${p.cores.map(c => `<span class="lj-paleta__c" style="background:${c}"></span>`).join('')}
            </span>
            <span class="lj-paleta__nome">${p.label}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderCores() {
  const grid = document.getElementById('coresGrid');
  grid.innerHTML = State.data.cores.map(c => `
    <button class="lj-cor-chip ${c.slug === State.cor ? 'lj-cor-chip--ativo' : ''}" data-cor="${c.slug}" aria-label="${c.nome}">
      <span class="lj-cor-chip__swatch" style="background:${c.hex}"></span>
    </button>
  `).join('');
  grid.querySelectorAll('.lj-cor-chip').forEach(el => {
    el.addEventListener('click', () => {
      State.cor = el.dataset.cor;
      renderCores();
      atualizarVisual();
    });
  });
}

function renderTamanhos() {
  const grid = document.getElementById('tamanhosGrid');
  grid.innerHTML = State.data.tamanhos.adulto.map(t => `
    <button class="lj-tam-chip ${t === State.tamanho ? 'lj-tam-chip--ativo' : ''}" data-tam="${t}">${t}</button>
  `).join('');
  grid.querySelectorAll('.lj-tam-chip').forEach(el => {
    el.addEventListener('click', () => {
      State.tamanho = el.dataset.tam;
      renderTamanhos();
      atualizarCTA();
    });
  });
}

function bindCamposEventos(modelo) {
  document.querySelectorAll('[data-campo]').forEach(el => {
    el.addEventListener('input', () => {
      State.perso[el.dataset.campo] = el.value;
      const bloco = el.closest('.lj-campo, .lj-perso-bloco');
      const contador = bloco?.querySelector('.lj-perso-label small, .lj-campo__label small');
      const campo = modelo.campos.find(c => c.id === el.dataset.campo);
      if (contador && campo?.maxLength) {
        contador.textContent = `${el.value.length}/${campo.maxLength}`;
      }
      autoSwitchParaCloseup();
      atualizarVisual();
      atualizarCTA();
    });
  });
  document.querySelectorAll('[data-sug]').forEach(el => {
    el.addEventListener('click', () => {
      const input = document.querySelector(`[data-campo="${el.dataset.sug}"]`);
      if (input) {
        input.value = el.dataset.val;
        State.perso[el.dataset.sug] = el.dataset.val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });
  document.querySelectorAll('[data-paleta]').forEach(el => {
    el.addEventListener('click', () => {
      State.paleta = el.dataset.paleta;
      document.querySelectorAll('[data-paleta]').forEach(x => x.classList.toggle('lj-paleta--ativa', x.dataset.paleta === State.paleta));
      atualizarVisual();
    });
  });
}

function alterarQtd(delta) {
  State.qtd = Math.max(1, State.qtd + delta);
  const el = document.getElementById('qtdVal');
  if (el) el.textContent = State.qtd;
  atualizarCTA();
}

// ─── VISUAL: camiseta com mockup pronto OU closeup dinâmico ──────
function atualizarVisual() {
  const modelo = State.data.modelos.find(m => m.slug === State.produtoSlug);
  const cor = State.data.cores.find(c => c.slug === State.cor);
  const wrap = document.getElementById('mockupWrap');
  if (!wrap) return;

  if (State.modoVisual === 'closeup') {
    // Closeup: estampa dinâmica grande no fundo escuro (só o brasão + ano)
    const svg = previewEstampa(modelo, State.perso, 'clara');
    wrap.innerHTML = `<div class="lj-closeup-canvas">${svg}</div>`;
    return;
  }

  // Modo camiseta: tenta mockup FINALIZADO (foto pronta com estampa aplicada)
  // Ex: /assets/mockups-brasao/camiseta-preta-pai.jpg
  // Se não existir, cai no mockup lisos + estampa sobreposta (comportamento antigo)
  const slugCampo = (() => {
    if (modelo.slug === 'emblema-raizes') {
      return (RELACAO_SLUG[State.perso.relacao] || 'pai').toLowerCase();
    }
    return modelo.slug;
  })();
  const mockupFinal = `/assets/mockups-brasao/camiseta-${cor.slug}-${slugCampo}.jpg`;

  const tomEstampa = cor.estampaClara ? 'clara' : 'escura';
  const svg = previewEstampa(modelo, State.perso, tomEstampa);
  const estampaClass = 'lj-mockup-estampa'
    + (modelo.slug === 'regionalismo-minimal' ? ' lj-mockup-estampa--minimal' : '')
    + (modelo.slug === 'palavras-coloridas' ? ' lj-mockup-estampa--quatro' : '');

  // Tenta mockup finalizado (imagem única). Se falhar, exibe camiseta base + estampa sobreposta.
  wrap.innerHTML = `
    <img class="lj-mockup-camiseta lj-mockup-final" src="${mockupFinal}" alt="Camiseta ${cor.nome} com estampa ${modelo.nome}"
      onerror="this.style.display='none';this.parentElement.classList.add('sem-mockup-final')">
    <div class="lj-mockup-fallback">
      <img class="lj-mockup-camiseta" src="${cor.mockup}" alt="Camiseta ${cor.nome}"
        data-cor-clara="${cor.estampaClara}"
        onerror="this.classList.add('lj-mockup-camiseta--fallback');this.removeAttribute('src');this.setAttribute('data-cor-clara','${cor.estampaClara}');this.style.background='${cor.hex}';">
      <div class="${estampaClass}">${svg}</div>
    </div>
  `;
}

// Auto-switch pra closeup na primeira edição — a pessoa quer ver o brasão de perto quando começa a mexer
function autoSwitchParaCloseup() {
  if (State.modoVisual === 'closeup' || State.editouAlgo) return;
  State.editouAlgo = true;
  State.modoVisual = 'closeup';
  const visual = document.getElementById('produtoVisual');
  if (visual) visual.setAttribute('data-modo', 'closeup');
  document.querySelectorAll('.lj-visual-toggle button').forEach(x => {
    x.classList.toggle('ativo', x.dataset.visual === 'closeup');
  });
  atualizarVisual();
}

function atualizarCTA() {
  const total = precoBase() * State.qtd;
  const totalEl = document.getElementById('ctaTotal');
  const subEl = document.getElementById('ctaSub');
  const precoDetalheEl = document.getElementById('precoDetalhe');
  if (totalEl) totalEl.textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
  if (subEl) subEl.textContent = `${State.qtd} unid.`;
  if (precoDetalheEl) precoDetalheEl.textContent = `R$ ${precoBase().toFixed(2).replace('.', ',')}`;

  const modelo = State.data.modelos.find(m => m.slug === State.produtoSlug);
  const camposOk = modelo.campos
    .filter(c => c.obrigatorio !== false)
    .every(c => {
      const v = State.perso[c.id];
      return v !== undefined && v !== null && String(v).trim().length > 0;
    });
  const habilitar = camposOk && State.correta;
  const textoCTA = !State.correta
    ? 'Confirme os dados'
    : (camposOk ? 'Enviar pelo WhatsApp' : 'Preencha a personalização');

  ['ctaBtn', 'ctaBtnDesktop'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = !habilitar;
    const span = b.querySelector('span');
    if (span) span.textContent = textoCTA;
  });
}

// ─── PREVIEW DA ESTAMPA ──────────────────────────────────────────
// Emblema usa composição de PNGs (imagem base + dígitos do ano).
// Se algum PNG faltar, cai automaticamente no SVG.
function previewEstampa(modelo, dados, tomFundo /* 'clara' | 'escura' */) {
  const corTexto = tomFundo === 'clara' ? '#f4f1ea' : '#111111';
  if (modelo.slug === 'emblema-raizes') return htmlEmblema(dados);
  if (modelo.slug === 'palavras-coloridas') return svgPalavrasColoridas(dados);
  if (modelo.slug === 'regionalismo-minimal') return svgMinimal(dados, corTexto);
  return '';
}

// Mapa explícito pra evitar colisão de slug (AVÔ vs AVÓ, TIO vs TIA, etc)
const RELACAO_SLUG = {
  'PAI':      'pai',
  'MÃE':      'mae',
  'AVÔ':      'avo',
  'AVÓ':      'avoo',       // "avoo" pra não colidir com "avo"
  'PADRINHO': 'padrinho',
  'MADRINHA': 'madrinha',
  'TIO':      'tio',
  'TIA':      'tia',
  'IRMÃO':    'irmao',
  'IRMÃ':     'irmaa',      // "irmaa" pra não colidir com "irma" (se houver)
  'FILHO':    'filho',
  'FILHA':    'filha'
};

// Emblema: composição de imagem base (por relação) + dígitos do ano
// Fallback: se a base PNG não existe, o <img> falha e mostramos o SVG antigo
function htmlEmblema(dados) {
  const rel = dados.relacao || 'PAI';
  const slug = RELACAO_SLUG[rel] || rel.toLowerCase();
  const ano = String(dados.ano || 1970);
  const svgFallback = svgEmblema(dados, '#c9a875');
  const digitos = ano.split('').map(d => `<img src="/assets/brasoes/numero-${d}.png" alt="${d}" onerror="this.style.display='none'">`).join('');
  return `
    <div class="brasao-comp" data-fallback-active="false">
      <img class="brasao-base" src="/assets/brasoes/brasao-${slug}.png" alt="Brasão ${rel}"
        onload="this.parentElement.classList.add('has-base')"
        onerror="this.parentElement.setAttribute('data-fallback-active','true');this.style.display='none';">
      <div class="brasao-ano" aria-label="Ano ${ano}">${digitos}</div>
      <div class="brasao-svg-fallback">${svgFallback}</div>
    </div>
  `;
}

// EMBLEMA: circular dourado, "RAÍZES QUE ENSINAM" no topo, "LEGADO QUE FICA" na base,
// árvore com raízes descendo até o ano, "PAI" grande no centro
function svgEmblema(dados, corTexto) {
  const rel = (dados.relacao || 'PAI');
  const ano = dados.ano || '1970';
  const g1 = '#e0c072'; // dourado claro
  const g2 = '#a67f38'; // dourado escuro
  return `
  <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="dourado" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${g1}"/>
        <stop offset=".5" stop-color="${g2}"/>
        <stop offset="1" stop-color="${g1}"/>
      </linearGradient>
      <radialGradient id="fundoEmb" cx=".5" cy=".5" r=".6">
        <stop offset="0" stop-color="#1a1a1a"/>
        <stop offset="1" stop-color="#000"/>
      </radialGradient>
      <path id="arcTopo-${rel}-${ano}" d="M 60 200 A 140 140 0 0 1 340 200" fill="none"/>
      <path id="arcBase-${rel}-${ano}" d="M 60 200 A 140 140 0 0 0 340 200" fill="none"/>
    </defs>
    <!-- Fundo escuro (opcional) -->
    <circle cx="200" cy="200" r="196" fill="url(#fundoEmb)"/>
    <!-- Anéis dourados -->
    <circle cx="200" cy="200" r="180" fill="none" stroke="url(#dourado)" stroke-width="2.5"/>
    <circle cx="200" cy="200" r="170" fill="none" stroke="url(#dourado)" stroke-width="1"/>
    <!-- Texto do arco topo -->
    <text fill="url(#dourado)" font-family="Fraunces, serif" font-size="22" font-weight="600" letter-spacing="7">
      <textPath href="#arcTopo-${rel}-${ano}" startOffset="50%" text-anchor="middle">RAÍZES QUE ENSINAM</textPath>
    </text>
    <text fill="url(#dourado)" font-family="Fraunces, serif" font-size="22" font-weight="600" letter-spacing="7">
      <textPath href="#arcBase-${rel}-${ano}" startOffset="50%" text-anchor="middle">LEGADO QUE FICA</textPath>
    </text>
    <!-- Bolinhas de separação (lado esquerdo/direito) -->
    <circle cx="42" cy="200" r="4" fill="url(#dourado)"/>
    <circle cx="358" cy="200" r="4" fill="url(#dourado)"/>
    <!-- Árvore (copa densa) -->
    <g transform="translate(200 120)" fill="url(#dourado)">
      <!-- Copa: várias circunferências sobrepostas -->
      <circle cx="0" cy="0" r="26" opacity=".95"/>
      <circle cx="-22" cy="8" r="20" opacity=".9"/>
      <circle cx="22" cy="8" r="20" opacity=".9"/>
      <circle cx="-14" cy="-14" r="18" opacity=".92"/>
      <circle cx="14" cy="-14" r="18" opacity=".92"/>
      <circle cx="0" cy="-22" r="16" opacity=".9"/>
      <!-- Detalhes textura folhas -->
      <circle cx="-30" cy="-4" r="8" opacity=".55"/>
      <circle cx="30" cy="-4" r="8" opacity=".55"/>
      <circle cx="0" cy="22" r="10" opacity=".7"/>
      <!-- Tronco -->
      <rect x="-3" y="24" width="6" height="34" rx="1"/>
    </g>
    <!-- "PAI" grande no centro -->
    <text x="200" y="240" text-anchor="middle" fill="url(#dourado)"
      font-family="Fraunces, serif" font-size="82" font-weight="600" letter-spacing="6">${escapeXml(rel)}</text>
    <!-- Raízes (linhas orgânicas descendo pra baixo do texto) -->
    <g stroke="url(#dourado)" stroke-width="1.3" fill="none" opacity=".9">
      <path d="M180 250 C 172 262, 168 280, 155 295"/>
      <path d="M186 253 C 178 268, 172 285, 160 305"/>
      <path d="M195 254 C 190 275, 187 295, 178 315"/>
      <path d="M205 254 C 210 275, 213 295, 222 315"/>
      <path d="M214 253 C 222 268, 228 285, 240 305"/>
      <path d="M220 250 C 228 262, 232 280, 245 295"/>
      <!-- raízes secundárias -->
      <path d="M170 268 C 160 278, 148 285, 138 288"/>
      <path d="M230 268 C 240 278, 252 285, 262 288"/>
    </g>
    <!-- Ano centralizado entre as raízes -->
    <text x="200" y="285" text-anchor="middle" fill="url(#dourado)"
      font-family="Fraunces, serif" font-size="30" font-weight="600" letter-spacing="4">${escapeXml(String(ano))}</text>
  </svg>`;
}

// PALAVRAS COLORIDAS: até 6 linhas, fonte Handelson, cores rotacionadas da paleta
function svgPalavrasColoridas(dados) {
  const modelo = State.data.modelos.find(m => m.slug === 'palavras-coloridas');
  const paleta = modelo.paletas.find(p => p.slug === State.paleta) || modelo.paletas[0];
  const linhas = ['linha1','linha2','linha3','linha4','linha5','linha6']
    .map(k => (dados[k] || '').trim())
    .filter(l => l.length > 0);

  if (linhas.length === 0) return '';

  const w = 400;
  const gap = 76;
  const startY = 68 + (6 - linhas.length) * 6;
  const h = startY + linhas.length * gap;

  const fontSize = (t) => {
    // Ajusta fonte pelo comprimento
    if (t.length > 14) return 58;
    if (t.length > 10) return 68;
    return 78;
  };

  return `
  <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <style>
      .pc-txt { font-family: 'Handelson', 'Playfair Display', serif; font-weight: 400; }
    </style>
    ${linhas.map((txt, i) => `
      <text class="pc-txt" x="${w/2}" y="${startY + i * gap}" text-anchor="middle"
        fill="${paleta.cores[i % paleta.cores.length]}" font-size="${fontSize(txt)}">${escapeXml(txt.toUpperCase())}</text>
    `).join('')}
  </svg>`;
}

// MINIMAL: Montserrat Black
function svgMinimal(dados, corTexto) {
  const txt = (dados.expressao || 'piazinho.');
  const size = txt.length > 12 ? 46 : txt.length > 8 ? 60 : 78;
  return `
  <svg viewBox="0 0 400 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <style>
      .mn-txt { font-family: 'MontserratBlack', 'Inter', sans-serif; font-weight: 900; letter-spacing: -1px; }
    </style>
    <text class="mn-txt" x="200" y="100" text-anchor="middle" fill="${corTexto}" font-size="${size}">${escapeXml(txt)}</text>
  </svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[ch]));
}

function precoBase() {
  return State.config.precos[State.regiao].personalizado;
}

// ─── MODAL WHATSAPP ──────────────────────────────────────────────
function abrirModalWapp() {
  const modelo = State.data.modelos.find(m => m.slug === State.produtoSlug);
  const cor = State.data.cores.find(c => c.slug === State.cor);
  const total = precoBase() * State.qtd;

  const linhas = [];
  linhas.push(`<div class="lj-resumo-linha"><span>Produto</span><strong>${modelo.nome}</strong></div>`);
  linhas.push(`<div class="lj-resumo-linha"><span>Loja</span><strong>${REGIOES_LABEL[State.regiao]}</strong></div>`);
  modelo.campos.forEach(c => {
    let v = State.perso[c.id];
    if (v === '' || v === undefined || v === null) return;
    linhas.push(`<div class="lj-resumo-linha"><span>${c.label}</span><strong>${escapeXml(String(v))}</strong></div>`);
  });
  if (modelo.paletas) {
    const p = modelo.paletas.find(x => x.slug === State.paleta);
    linhas.push(`<div class="lj-resumo-linha"><span>Paleta</span><strong>${p.label}</strong></div>`);
  }
  linhas.push(`<div class="lj-resumo-linha"><span>Cor</span><strong>${cor.nome}</strong></div>`);
  linhas.push(`<div class="lj-resumo-linha"><span>Tamanho</span><strong>${State.tamanho}</strong></div>`);
  linhas.push(`<div class="lj-resumo-linha"><span>Quantidade</span><strong>${State.qtd}</strong></div>`);
  linhas.push(`<div class="lj-resumo-linha lj-resumo-linha--total"><span>Total</span><strong>R$ ${total.toFixed(2).replace('.', ',')}</strong></div>`);
  document.getElementById('modalResumo').innerHTML = linhas.join('');

  const btn = document.getElementById('btnConfirmarWapp');
  btn.onclick = () => {
    logEvento('checkout_wapp_click', { produto: modelo.slug });
    window.location.href = wappUrl(mensagemWapp(modelo, cor, total));
  };

  document.getElementById('modalWapp').classList.add('aberto');
}

const Loja = {
  fecharModal() {
    document.querySelectorAll('.lj-modal-overlay').forEach(m => m.classList.remove('aberto'));
  },
  abrirTrocaLoja() {
    document.getElementById('modalTroca').classList.add('aberto');
  }
};
window.Loja = Loja;

document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('lj-modal-overlay')) Loja.fecharModal();
});

function mensagemWapp(modelo, cor, total) {
  const linhas = [];
  linhas.push(`Olá! Quero encomendar essa personalização da ${REGIOES_LABEL[State.regiao]}.`);
  linhas.push('');
  linhas.push(`🛒 *${modelo.nome}*`);
  linhas.push(`   ${modelo.subtitulo}`);
  linhas.push('');
  linhas.push('✍️ *Personalização:*');
  modelo.campos.forEach(c => {
    const v = State.perso[c.id];
    if (v === '' || v === undefined || v === null) return;
    linhas.push(`   • ${c.label}: ${v}`);
  });
  if (modelo.paletas) {
    const p = modelo.paletas.find(x => x.slug === State.paleta);
    linhas.push(`   • Paleta: ${p.label}`);
  }
  linhas.push('');
  linhas.push(`👕 Cor: ${cor.nome}  |  Tamanho: ${State.tamanho}  |  Qtd: ${State.qtd}`);
  linhas.push(`💰 Total: R$ ${total.toFixed(2).replace('.', ',')}`);
  linhas.push('');
  linhas.push('📍 Endereço pra envio:');
  linhas.push('_(preencher aqui: nome, rua, número, bairro, cidade/UF, CEP)_');
  linhas.push('');
  linhas.push('💳 Forma de pagamento preferida: PIX / cartão / boleto');
  return linhas.join('\n');
}

function wappUrl(msg) {
  const numero = State.config?.whatsapp?.number || '5548999999999';
  return `https://wa.me/${numero}?text=${encodeURIComponent(msg)}`;
}

function logEvento(event, extra) {
  try {
    fetch('/api/loja/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, region: State.regiao, ...extra })
    });
  } catch (e) { /* silêncio */ }
}

function scrollToId(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
