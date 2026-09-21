import { Link } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ds';

// Endereço que não existe dentro do painel. Sem esta rota a tela ficava em BRANCO (sem menu, sem
// mensagem) e parecia que a página "não carregou".
export function PaginaNaoEncontrada() {
  return (
    <>
      <PageHeader title="Página não encontrada" />
      <EmptyState
        title="Este endereço não existe no painel"
        description="Use o menu ao lado ou volte para a visão geral."
        action={<Link to="/admin/dashboard" className="ds-btn ds-btn--secondary">Ir para a visão geral</Link>}
      />
    </>
  );
}
