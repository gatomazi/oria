import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Callout, EmptyState, PageHeader, PageStack, Skeleton, TabList } from '../../components/ds';
import { afiliados, type CapacidadesCupom, type Papel } from '../../api/afiliados';
import { useStatusAfiliados } from '../../state/afiliadosModulo';
import { TZ_PADRAO } from '../../lib/parcerias';

import '../../parcerias.css';

// Casca do módulo: confere a flag do servidor, expõe papel/fuso da loja às telas filhas e desenha a navegação interna.
// Nada aqui é autorização — o servidor recusa a rota mesmo que a aba apareça; a aba só evita mostrar o que o papel não pode usar.
export interface ContextoParcerias { papel: Papel; isOwner: boolean; tz: string; cupons: CapacidadesCupom }
const Ctx = createContext<ContextoParcerias | null>(null);

export function useParcerias(): ContextoParcerias {
  const v = useContext(Ctx);
  if (!v) throw new Error('useParcerias fora de <ParceriasLayout>');
  return v;
}

type Aba = 'visao' | 'parceiros' | 'a-pagar' | 'collabs' | 'vendas' | 'revisoes' | 'niveis';
const CAMINHOS: Record<Aba, string> = {
  visao: '/admin/parcerias', parceiros: '/admin/parcerias/parceiros', 'a-pagar': '/admin/parcerias/a-pagar', collabs: '/admin/parcerias/collabs',
  vendas: '/admin/parcerias/vendas', revisoes: '/admin/parcerias/revisoes', niveis: '/admin/parcerias/niveis',
};

function abaAtual(pathname: string): Aba {
  const achado = (Object.entries(CAMINHOS) as [Aba, string][])
    .filter(([, c]) => c !== CAMINHOS.visao && (pathname === c || pathname.startsWith(`${c}/`)))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return achado ? achado[0] : 'visao';
}

export function ParceriasLayout() {
  const status = useStatusAfiliados();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [tz, setTz] = useState(TZ_PADRAO);

  useEffect(() => {
    if (!status || !status.enabled) return;
    afiliados.config().then((c) => setTz(c.timezone)).catch(() => undefined);
  }, [status]);

  const contexto = useMemo<ContextoParcerias | null>(() => (status && status.papel ? { papel: status.papel, isOwner: status.papel === 'owner', tz, cupons: status.couponCreation } : null), [status, tz]);

  if (status === null) {
    return (
      <PageStack>
        <Skeleton rows={1} height="56px" width="40%" />
        <Skeleton variant="table" rows={5} />
      </PageStack>
    );
  }
  if (!status.enabled || !contexto) {
    return (
      <PageStack>
        <PageHeader title="Parcerias e Afiliados" description="Afiliados, collabs e comissões da sua loja." />
        <EmptyState title="Módulo ainda não liberado nesta loja" description="Este recurso está em validação e não foi ativado. Peça a liberação a quem administra o Oria." />
      </PageStack>
    );
  }

  const itens: { value: Aba; label: string }[] = [
    { value: 'visao', label: 'Visão geral' },
    { value: 'parceiros', label: 'Parceiros' },
    ...(contexto.isOwner ? [{ value: 'a-pagar' as Aba, label: 'A pagar' }] : []),
    { value: 'collabs', label: 'Collabs' },
    { value: 'vendas', label: 'Vendas atribuídas' },
    { value: 'revisoes', label: 'Revisões' },
    { value: 'niveis', label: 'Níveis e benefícios' },
  ];

  return (
    <Ctx.Provider value={contexto}>
      <div className="pa-shell">
        <TabList<Aba> label="Seções de Parcerias e Afiliados" items={itens} value={abaAtual(pathname)} onChange={(a) => navigate(CAMINHOS[a])} />
        {!contexto.isOwner && (
          <Callout tone="info" title="Acesso de acompanhamento">
            Seu papel permite cadastrar e acompanhar parceiros, collabs e cupons. Valores a pagar e pagamentos são do owner da loja; níveis e benefícios ficam em leitura.
          </Callout>
        )}
        <Outlet />
      </div>
    </Ctx.Provider>
  );
}
