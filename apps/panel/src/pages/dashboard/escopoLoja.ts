// Escopo de Store do Dashboard.
//
// O servidor devolve `loja: null` para toda linha da Store nativa do Oria (`loja_legada` NULA), e a
// Store ativa chega aqui como `null` (sessão) ou `''` (o `?? ''` das telas). Comparar com `===` fazia
// `null === ''` dar `false`: todo pedido, carrinho e linha financeira era filtrado e o Dashboard
// mostrava R$ 0,00 com 431 pedidos no banco. Ausente, vazio e nulo são a MESMA coisa: "sem chave
// legada". Só uma chave legada de verdade (`sul`, `centro`, `norte`) distingue uma linha de outra.
export function chaveDeLoja(loja: string | null | undefined): string | null {
  return loja ? loja : null;
}

export function mesmaLoja(a: string | null | undefined, b: string | null | undefined): boolean {
  return chaveDeLoja(a) === chaveDeLoja(b);
}

export function porEscopo<T extends { loja: string | null }>(lista: T[], escopo: string | null): T[] {
  return lista.filter((item) => mesmaLoja(item.loja, escopo));
}
