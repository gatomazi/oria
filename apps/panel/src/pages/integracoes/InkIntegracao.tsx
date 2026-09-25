import { Callout, StatusBadge, Tabs } from '../../components/ds';
import { formatData } from '../../lib/format';
import type { ReservaInkStatus } from '../../api/integracoes';
import { adminStores } from '../../state/adminStores';
import { useEntitlement } from '../../state/entitlements';
import { BackfillPedidosCard } from './BackfillPedidosCard';
import { CatalogoCacheCard } from './CatalogoCacheCard';
import { CatalogSyncCard } from './CatalogSyncCard';
import { InkConexaoSecao, InkRecebimentoSecao, useInkCredenciais } from './InkCredenciaisCard';
import { lojasComTokenInk } from './lojaOpcao';

export const ABAS_INK = ['conexao', 'pedidos', 'catalogo'] as const;

// Conteúdo expandido da Reserva Ink: resumo da saúde no alto e três abas — Conexão (credencial),
// Pedidos (recebimento automático e histórico) e Catálogo (busca e análises). Nada de tabela de
// depuração: é o que o lojista precisa para decidir o que fazer.
export function InkIntegracao({ reservaInk, aba, onAba }: { reservaInk: ReservaInkStatus[]; aba: string; onAba: (aba: string) => void }) {
  const estado = useInkCredenciais();
  // "Catálogo para análises" alimenta Desempenho de produtos e a Jornada de compra: só existe para quem tem a mesma feature que essas telas.
  const analisesDeCatalogo = useEntitlement('analytics_product_performance');
  const lojas = lojasComTokenInk(reservaInk);
  const principal = reservaInk[0] || null;
  const nomeDaLoja = principal ? principal.nome || (principal.loja ? adminStores.name(principal.loja) : null) : null;
  const ultimoEventoEm = reservaInk.find((r) => r.ultimoEventoEm)?.ultimoEventoEm ?? null;
  const indice = Math.max(0, ABAS_INK.indexOf(aba as (typeof ABAS_INK)[number]));

  const semCredencial = (
    <Callout tone="info" title="Cadastre a credencial primeiro">
      Pedidos e catálogo dependem da credencial da Reserva Ink. Cadastre o token na aba Conexão.
    </Callout>
  );

  return (
    <>
      {principal && (
        <dl className="ig-fatos" aria-label="Saúde da conexão com a Reserva Ink">
          <div>
            <dt>Loja</dt>
            <dd>{nomeDaLoja || 'Sua loja'}</dd>
          </div>
          <div>
            <dt>Credencial</dt>
            <dd>
              <StatusBadge tone={principal.tokenConfigurado ? 'success' : 'neutral'} label={principal.tokenConfigurado ? 'Cadastrada' : 'Não cadastrada'} />
            </dd>
          </div>
          <div>
            <dt>Recebimento automático</dt>
            <dd>
              <StatusBadge tone={principal.webhookConfigurado ? 'success' : 'neutral'} label={principal.webhookConfigurado ? 'Ativo' : 'Não ativado'} />
            </dd>
          </div>
          <div>
            <dt>Último evento recebido</dt>
            <dd>{ultimoEventoEm ? formatData(ultimoEventoEm) : 'Nenhum ainda'}</dd>
          </div>
        </dl>
      )}
      <div className="ig-abas">
        <Tabs
          label="Seções da Reserva Ink"
          activeIndex={indice}
          onChangeIndex={(i) => onAba(ABAS_INK[i])}
          tabs={[
            { label: 'Conexão', render: () => <InkConexaoSecao estado={estado} lojaNome={nomeDaLoja} /> },
            {
              label: 'Pedidos',
              render: () => (
                <div className="ig-secoes">
                  <InkRecebimentoSecao estado={estado} ultimoEventoEm={ultimoEventoEm} />
                  {lojas.length ? <BackfillPedidosCard stores={lojas} /> : semCredencial}
                </div>
              ),
            },
            {
              label: 'Catálogo',
              render: () =>
                lojas.length ? (
                  <div className="ig-secoes">
                    <CatalogoCacheCard stores={lojas} />
                    {analisesDeCatalogo && <CatalogSyncCard />}
                  </div>
                ) : (
                  semCredencial
                ),
            },
          ]}
        />
      </div>
    </>
  );
}
