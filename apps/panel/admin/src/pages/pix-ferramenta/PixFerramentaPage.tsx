import { Card, PageHeader } from '../../components/ds';

import '../../../../src/dashboard.css';
import '../../../../src/pix-ferramenta.css';

// Porte de src/pix-ferramenta.js (Fase 3, docs/plan.md).
// Ferramenta enxuta de propósito: cadastro/vínculo/QR/copia-e-cola de PIX já existem e funcionam
// em /admin/pedidos* — recriar aqui duplicaria lógica real de pagamento. Esta página só organiza
// o acesso.
function LinkCard({ title, description, href, label, variant = 'secondary' }: { title: string; description: string; href: string; label: string; variant?: 'primary' | 'secondary' }) {
  return (
    <Card title={title} description={description}>
      <a href={href} className={`ds-btn ds-btn--${variant}`}>
        {label}
      </a>
    </Card>
  );
}

// Achado do refinamento visual: os 4 cards tinham o mesmo peso visual, mas "Pedidos PIX" é a
// ação principal (lista completa, QR, copia-e-cola) — as outras 3 são atalhos secundários pra
// fluxos que já existem em /admin/pedidos*. Card principal maior/destacado, resto em fileira menor.
export function PixFerramentaPage() {
  return (
    <>
      <PageHeader title="PIX" description="Cadastro, vínculo e acompanhamento de pagamentos PIX." />
      <div className="pix-principal">
        <LinkCard
          title="Pedidos PIX"
          description="Lista completa, com QR code e link de pagamento por pedido."
          href="/admin/pedidos"
          label="Ver pedidos"
          variant="primary"
        />
      </div>
      <div className="pix-secundarios">
        <LinkCard
          title="Cadastrar PIX manual"
          description="Crie uma hotpage de pagamento pra um pedido que ainda não tem uma."
          href="/admin/pedidos/novo"
          label="Cadastrar"
        />
        <LinkCard
          title="Vincular pedido"
          description="Associe um pedido real da Reserva Ink a uma hotpage existente."
          href="/admin/pedidos/vincular"
          label="Vincular"
        />
        <LinkCard
          title="Recuperação"
          description="Acompanhe tentativas de lembrete e status de PIX pendente."
          href="/admin/recuperacao"
          label="Ver recuperação"
        />
      </div>
    </>
  );
}
