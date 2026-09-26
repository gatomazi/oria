#!/bin/sh
# Matriz de POC de armazenamento: escalas pequenas/médias (5k, 10k), mixes, SKU único, arms de sync/índices.
# Uso: sh run-matrix.sh   (Postgres 18 local em oria-storage-poc-pg; ver run.cjs)
cd "$(dirname "$0")/../../.." || exit 1
R="node --expose-gc scripts/dev/storage-poc/run.cjs --bench=0 --cycles=2"
for n in 5000 10000; do
  for mix in usesul published light; do
    for arm in materialized derived; do
      $R --arm=$arm --products=$n --mix=$mix --label=$arm-$n-$mix
    done
  done
done
# SKU único por variante (caso típico de outras lojas): o bootstrap materializa uma identity `sku` por variante
for arm in materialized derived; do
  $R --arm=$arm --products=10000 --mix=published --sku=unique --label=$arm-10000-published-skuunique
done
# Arms de sync (S), fillfactor e índices (E) sobre o modo derived
for mix in usesul published; do
  $R --arm=derived --sweep=per_product --products=10000 --mix=$mix --label=der-sw-10000-$mix
  $R --arm=derived --sweep=per_product --vff=90 --products=10000 --mix=$mix --label=der-sw-ff90-10000-$mix
  $R --arm=derived --sweep=per_product --dropidx=1 --products=10000 --mix=$mix --label=stack-10000-$mix
done
