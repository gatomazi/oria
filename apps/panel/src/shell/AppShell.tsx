import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import { useAuth } from '../auth/AuthContext';
import { loadProductSettings, type ProductSettings } from '../state/productSettings';
import { loadEntitlements, hasEntitlement, entitlementsCarregados } from '../state/entitlements';
import { Icon, Select, Skeleton, Tooltip } from '../components/ds';
import { useMediaQuery } from '../lib/useMediaQuery';
import { alternarColapso, alternarGrupo, gravarPrefs, grupoAberto, itensVisiveis, lerPrefs, type NavPrefs } from './navPrefs';
import { getInternalToolsStatus } from '../api/internalTools';
import { useWhatsappProvider } from '../state/whatsappProvider';
import { AlertaAppWhatsapp } from '../components/AlertaAppWhatsapp';
import { NAV_TOP, NAV_GROUPS, NAV_STORE_MENU, STORE_MENU_GROUP, PAGE_TITLES, NAV_ICON_PATHS, ROUTE_CONTEXT, type NavItem, type NavGroup } from './nav';

// Shell do painel (DESIGN.md › Layout, Navigation, Top Bar): sidebar de 240px (drawer abaixo de
// 1024px), topbar sticky de 56px com breadcrumb + troca de workspace (só para quem tem mais de uma
// Organization) + menu da loja, e container de conteúdo alinhado com a topbar. A sidebar é só
// operação do dia a dia; a administração da loja (Configurações, Integrações, Campos personalizados)
// mora exclusivamente no menu da loja (NAV_STORE_MENU). Sem busca global,
// ajuda ou notificações até essas funções existirem (decisão D1). Não existe "todas as lojas": cada
// sessão trabalha numa Organization, escolhida e validada no servidor (Fase 3).

// "Ferramentas internas" (Migração Use Origens) não entra em NAV_GROUPS/nav.ts porque essa lista
// é estática e importada eagerly — mostrar o grupo sempre e só confiar em "esconder" não seria
// proteção nenhuma. Aqui é só cosmético mesmo: o backend (requireInternalTools) é quem bloqueia
// de verdade se a env var estiver desligada.
function useFerramentasInternasGroup(): NavGroup | null {
  const [habilitada, setHabilitada] = useState(false);
  useEffect(() => {
    getInternalToolsStatus().then((d) => setHabilitada(d.enabled)).catch(() => setHabilitada(false));
  }, []);
  if (!habilitada) return null;
  return {
    label: 'Ferramentas internas',
    items: [{ key: 'origens-migration', label: 'Migração Use Origens', href: '/admin/internal/origens-migration' }],
  };
}

function navIcon(key: string, className = 'ad-nav__icon') {
  const inner = NAV_ICON_PATHS[key];
  if (!inner) return null;
  return (
    <span className={className}>
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: inner }}
      />
    </span>
  );
}

function NavLink({ item, activeKey, reduzida }: { item: NavItem; activeKey: string; reduzida?: boolean }) {
  const ativo = item.key === activeKey;
  const link = (
    <Link to={item.href ?? '#'} className={'ad-nav__item' + (ativo ? ' ad-nav__item--active' : '')} aria-current={ativo ? 'page' : undefined}>
      {navIcon(item.key) ?? <span className="ad-nav__icon ad-nav__icon--inicial" aria-hidden="true">{item.label.slice(0, 1)}</span>}
      {/* Reduzida: o rótulo sai da tela mas continua sendo o nome acessível do link. */}
      <span className="ad-nav__label">{item.label}</span>
    </Link>
  );
  // Sidebar reduzida (só ícones): o nome aparece em tooltip ao passar o mouse OU focar pelo teclado.
  return reduzida ? <Tooltip content={item.label} side="right">{link}</Tooltip> : link;
}

interface RouteInfo {
  activeKey: string;
  title: string;
  group: string | null;
  parent: NavItem | null;
}

// Resolve item ativo, título da aba e breadcrumb a partir da rota: contexto declarado em
// ROUTE_CONTEXT (páginas filhas e fora do menu) ou, senão, o item de navegação com o href mais
// longo que casa com a rota.
function useRouteInfo(extraGroup: NavGroup | null): RouteInfo {
  const { pathname } = useLocation();
  return useMemo(() => {
    const groups = [...NAV_GROUPS, ...(extraGroup ? [extraGroup] : [])];
    const groupOf = (key: string) => groups.find((g) => g.items.some((i) => i.key === key))?.label ?? null;
    const all = [...NAV_TOP, ...groups.flatMap((g) => g.items)];

    // Páginas do menu da loja: sem item ativo na sidebar, breadcrumb "Loja › Página".
    const daLoja = NAV_STORE_MENU.find((i) => i.href && (pathname === i.href || pathname.startsWith(i.href + '/')));
    if (daLoja) return { activeKey: '', title: PAGE_TITLES[daLoja.key] || daLoja.label, group: STORE_MENU_GROUP, parent: null };

    const ctx = ROUTE_CONTEXT.find((c) => c.match.test(pathname));
    if (ctx) {
      const parent = ctx.parentKey ? all.find((i) => i.key === ctx.parentKey) ?? null : null;
      return { activeKey: ctx.parentKey ?? '', title: ctx.title, group: parent ? groupOf(parent.key) : ctx.group ?? null, parent };
    }

    let best: NavItem | null = null;
    for (const item of all) {
      if (!item.href) continue;
      if (pathname === item.href || pathname.startsWith(item.href + '/')) {
        if (!best || item.href.length > (best.href?.length ?? 0)) best = item;
      }
    }
    if (!best) return { activeKey: '', title: '', group: null, parent: null };
    return { activeKey: best.key, title: PAGE_TITLES[best.key] || best.label, group: groupOf(best.key), parent: null };
  }, [pathname, extraGroup]);
}

function initials(text: string): string {
  const palavras = text.trim().split(/\s+/).filter(Boolean);
  if (!palavras.length) return '?';
  if (palavras.length === 1) return palavras[0].slice(0, 2).toUpperCase();
  return (palavras[0][0] + palavras[1][0]).toUpperCase();
}

// Troca de workspace: só aparece para quem tem mais de um membership. A escolha vai para o
// servidor, que confere o membership e recarrega o painel na Organization nova.
function WorkspaceSelect() {
  const { memberships, organizacaoAtiva, selecionarOrganizacao } = useAuth();
  const [trocando, setTrocando] = useState(false);
  if (memberships.length < 2 || !organizacaoAtiva) return null;
  return (
    <Select
      className="ad-scope"
      controlSize="sm"
      aria-label="Loja em que você está trabalhando"
      value={organizacaoAtiva.id}
      disabled={trocando}
      onChange={(ev) => {
        setTrocando(true);
        selecionarOrganizacao(ev.target.value).catch(() => setTrocando(false));
      }}
    >
      {memberships.map((m) => (
        <option key={m.organizationId} value={m.organizationId}>
          {m.nome}
        </option>
      ))}
    </Select>
  );
}

// Plano da Organization para o cabeçalho do menu da loja. `null` = ainda carregando ou o servidor
// não respondeu: a linha some em vez de mostrar "Sem plano ativo" por engano (o carregador de
// entitlements é fail-closed e devolveria "nada" num erro de rede).
function usePlanoLabel(): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    loadEntitlements().then(() => {
      if (!vivo) return;
      if (!entitlementsCarregados()) return setLabel(null);
      const wa = hasEntitlement('whatsapp');
      const ig = hasEntitlement('instagram');
      if (wa && ig) setLabel('Plano atual: Completo');
      else if (wa) setLabel('Plano atual: WhatsApp');
      else if (ig) setLabel('Plano atual: Instagram');
      else setLabel('Sem plano ativo');
    });
    return () => { vivo = false; };
  }, []);
  return label;
}

// Menu da loja (canto superior direito): identificação, administração da loja e Sair. Os itens vêm
// de NAV_STORE_MENU; o servidor continua sendo quem autoriza cada rota e API — aqui é só navegação.
function StoreMenu({
  nome,
  plano,
  usuario,
  onLogout,
}: {
  nome: string;
  plano: string | null;
  usuario: string | null;
  onLogout: () => void;
}) {
  const { pathname } = useLocation();
  // O gatilho identifica a CONTA (iniciais de quem está logado), não a loja: o nome da loja já está no seletor de loja (quando há
  // mais de uma) e dentro do menu. Assim os dois controles do canto direito nunca mostram o mesmo texto.
  const rotulo = 'Abrir menu da conta e da loja';
  return (
    <RadixDropdown.Root>
      <RadixDropdown.Trigger asChild>
        <button type="button" className="ad-store-menu" aria-label={rotulo} title={rotulo}>
          <span className="ad-store-menu__avatar" aria-hidden="true">
            {initials(usuario || nome)}
          </span>
          <Icon name="chevron-down" />
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content className="ds-dropdown ad-store-menu__content" align="end" sideOffset={6} collisionPadding={8}>
          <RadixDropdown.Label className="ds-dropdown__label">
            <strong>{nome}</strong>
            {plano && <span>{plano}</span>}
            {usuario && <span>{usuario}</span>}
          </RadixDropdown.Label>
          <RadixDropdown.Separator className="ds-dropdown__separator" />
          {NAV_STORE_MENU.filter((item) => item.href).map((item) => {
            const ativo = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <RadixDropdown.Item key={item.key} asChild className={'ds-dropdown__item' + (ativo ? ' ds-dropdown__item--active' : '')}>
                <Link to={item.href as string} aria-current={ativo ? 'page' : undefined}>
                  {navIcon(item.key, 'ds-dropdown__icon')}
                  {item.label}
                </Link>
              </RadixDropdown.Item>
            );
          })}
          <RadixDropdown.Separator className="ds-dropdown__separator" />
          <RadixDropdown.Item className="ds-dropdown__item" onSelect={onLogout}>
            <Icon name="logout" />
            Sair
          </RadixDropdown.Item>
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

function Breadcrumb({ info }: { info: RouteInfo }) {
  if (!info.title) return null;
  const crumbs: { label: string; to?: string }[] = [];
  if (info.group) crumbs.push({ label: info.group });
  if (info.parent) crumbs.push({ label: info.parent.label, to: info.parent.href });
  crumbs.push({ label: info.title });
  return (
    <nav className="ad-breadcrumb" aria-label="Você está em">
      <ol>
        {crumbs.map((c, i) => {
          const ultimo = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`}>
              {i > 0 && <Icon name="chevron-right" size={14} />}
              {ultimo ? <span aria-current="page">{c.label}</span> : c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const ferramentasInternasGroup = useFerramentasInternasGroup();
  const routeInfo = useRouteInfo(ferramentasInternasGroup);
  const { pathname } = useLocation();
  const { logout, usuario, organizacaoAtiva } = useAuth();
  const [settings, setSettings] = useState<ProductSettings | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  // Preferências locais da navegação (sidebar reduzida + grupos fechados). A reduzida só vale no desktop: o drawer do mobile não muda.
  const [prefs, setPrefs] = useState<NavPrefs>(() => lerPrefs());
  const desktop = useMediaQuery('(min-width: 1024px)');
  const reduzida = prefs.colapsada && desktop;
  useEffect(() => { gravarPrefs(prefs); }, [prefs]);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  // Foco de volta ao botão de menu DEPOIS que o drawer fecha (com o conteúdo já sem `inert`): focar no mesmo tick do Esc falhava, porque
  // o botão está dentro do conteúdo ainda inerte, e o foco ia para o <body>.
  const devolverFoco = useRef(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const planoLabel = usePlanoLabel();
  const whatsappProvider = useWhatsappProvider();
  // Itens sem href ("em breve") não aparecem (D2). Enquanto o provider não carrega, esconde os
  // itens condicionais (evita piscar o item errado).
  const itemVisivel = (item: NavItem) =>
    !!item.href && (!item.provider || item.provider === whatsappProvider) && (!item.feature || hasEntitlement(item.feature));

  useEffect(() => {
    loadProductSettings().then(setSettings);
  }, []);

  const nomeProduto = settings?.productName || 'Oria';

  useEffect(() => {
    document.title = (routeInfo.title ? routeInfo.title + ' · ' : '') + 'Admin — ' + nomeProduto;
  }, [routeInfo.title, nomeProduto]);

  // Drawer de navegação (<1024px): fecha ao navegar e com Esc; o foco vai pro "Fechar" ao abrir
  // e volta pro botão de menu ao fechar pelo teclado.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    closeBtnRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        devolverFoco.current = true;
        setNavOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    // Drawer aberto é modal: o conteúdo atrás fica fora da ordem de tabulação e da árvore de
    // acessibilidade. Ao alargar a janela até o layout de desktop (sidebar fixa) o drawer fecha,
    // para o conteúdo não ficar inerte sem menu para fechá-lo.
    const principal = mainRef.current;
    principal?.setAttribute('inert', '');
    const desktop = window.matchMedia('(min-width: 1024px)');
    const aoMudarLargura = () => { if (desktop.matches) setNavOpen(false); };
    desktop.addEventListener('change', aoMudarLargura);
    return () => {
      document.removeEventListener('keydown', onKey);
      desktop.removeEventListener('change', aoMudarLargura);
      principal?.removeAttribute('inert');
    };
  }, [navOpen]);

  useEffect(() => {
    if (navOpen || !devolverFoco.current) return;
    devolverFoco.current = false;
    menuBtnRef.current?.focus();
  }, [navOpen]);

  const grupos = [...NAV_GROUPS, ...(ferramentasInternasGroup ? [ferramentasInternasGroup] : [])]
    .map((g) => ({ ...g, items: g.items.filter(itemVisivel) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className={'ad-shell' + (navOpen ? ' ad-shell--nav-open' : '') + (prefs.colapsada ? ' ad-shell--nav-reduzida' : '')}>
      <aside className="ad-sidebar" id="ad-sidebar" aria-label="Navegação principal">
        <div className="ad-sidebar__brand">
          <div className="ad-sidebar__logo" aria-hidden="true">
            {settings ? initials(nomeProduto) : ''}
          </div>
          <div className="ad-sidebar__brand-text">
            <div className="ad-sidebar__brand-nome">{settings ? nomeProduto : <Skeleton rows={1} height="14px" width="120px" />}</div>
            <div className="ad-sidebar__brand-tagline">Central operacional</div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="ds-icon-btn ad-sidebar__close"
            aria-label="Fechar menu de navegação"
            onClick={() => {
              devolverFoco.current = true;
              setNavOpen(false);
            }}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <nav className="ad-nav">
          {NAV_TOP.map((item) => (
            <NavLink key={item.key} item={item} activeKey={routeInfo.activeKey} reduzida={reduzida} />
          ))}
          {grupos.map((group) => {
            const labelId = `nav-grupo-${group.label.toLowerCase().replace(/\s+/g, '-')}`;
            const listaId = `${labelId}-itens`;
            const aberto = grupoAberto(prefs, group.label);
            const visiveis = itensVisiveis(group.items, aberto, routeInfo.activeKey, reduzida);
            return (
              <div key={group.label} className="ad-nav__group" role="group" aria-labelledby={labelId}>
                <div className="ad-nav__group-label" id={labelId}>
                  {/* Grupo recolhível: mostra só a página atual quando fechado (a pessoa nunca perde onde está). */}
                  <button
                    type="button"
                    className="ad-nav__group-toggle"
                    aria-expanded={aberto}
                    aria-controls={listaId}
                    onClick={() => setPrefs((p) => alternarGrupo(p, group.label))}
                  >
                    <span>{group.label}</span>
                    <Icon name="chevron-down" size={14} />
                  </button>
                </div>
                <div id={listaId} className="ad-nav__group-items" hidden={visiveis.length === 0}>
                  {visiveis.map((item) => (
                    <NavLink key={item.key} item={item} activeKey={routeInfo.activeKey} reduzida={reduzida} />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="ad-sidebar__footer">
          <Tooltip content={prefs.colapsada ? 'Expandir menu lateral' : 'Recolher menu lateral'} side="right">
            <button
              type="button"
              className="ds-icon-btn ad-sidebar__collapse"
              aria-label={prefs.colapsada ? 'Expandir menu lateral' : 'Recolher menu lateral'}
              aria-expanded={!prefs.colapsada}
              aria-controls="ad-sidebar"
              onClick={() => setPrefs(alternarColapso)}
            >
              <Icon name={prefs.colapsada ? 'chevron-right' : 'chevron-left'} size={18} />
            </button>
          </Tooltip>
        </div>
      </aside>

      <div className="ad-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="ad-main" ref={mainRef}>
        <header className="ad-topbar">
          <div className="ad-topbar__inner">
            <button
              ref={menuBtnRef}
              type="button"
              className="ds-icon-btn ad-topbar__menu"
              aria-label="Abrir menu de navegação"
              aria-controls="ad-sidebar"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Icon name="menu" size={20} />
            </button>
            <Breadcrumb info={routeInfo} />
            <div className="ad-topbar__actions">
              <WorkspaceSelect />
              {settings && <StoreMenu
                  nome={organizacaoAtiva?.nome || nomeProduto}
                  plano={planoLabel}
                  usuario={usuario ? usuario.nome || usuario.email : null}
                  onLogout={() => logout()}
                />}
            </div>
          </div>
        </header>

        <main className="ad-content" id="ad-content">
          <div className="ad-content__inner">
            {settings ? (
              <>
                {whatsappProvider === 'whatsapp_web' && <AlertaAppWhatsapp />}
                {children}
              </>
            ) : (
              <div className="ad-shell-skeleton">
                <Skeleton rows={1} height="28px" width="240px" />
                <Skeleton rows={3} />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
