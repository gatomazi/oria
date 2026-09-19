// Reporter do `node --test` que mede quanto tempo cada ARQUIVO de teste consome.
//
// Serve só para BALANCEAR shards (scripts/ci/suites.mjs): nenhuma decisão de gate depende disto.
// O reporter do gate (apps/panel/scripts/productization/gate-reporter.mjs) é outro e continua
// intocado — ele responde por "o teste rodou", que é contrato; este responde por "quanto demorou".
//
// Por que não somar `duration_ms` dos testes: boa parte do custo real dos invariants está FORA do
// corpo dos testes — `before`/`after` que sobem o painel, criam banco descartável e rodam as
// migrations. Somando só os testes, arquivos caros aparecem como 0 s e o balanceamento fica pior do
// que o chute. Então aqui o tempo é de relógio: do primeiro ao último evento de cada arquivo.

export default async function* reporterDeDuracao(source) {
  const primeiro = new Map();
  const ultimo = new Map();

  for await (const ev of source) {
    const arquivo = ev.data?.file;
    // `test:enqueue` sai para TODOS os arquivos logo no começo (o runner enfileira a lista inteira),
    // então ele não marca o início de nada. O primeiro evento que significa "este arquivo começou a
    // rodar" é o `test:dequeue`.
    if (!arquivo || ev.type === 'test:enqueue') continue;
    const agora = Date.now();
    if (!primeiro.has(arquivo)) primeiro.set(arquivo, agora);
    ultimo.set(arquivo, agora);
  }

  // Uma linha por arquivo, no fim: `ms` é o intervalo em que aquele arquivo esteve produzindo
  // eventos. Com `--test-concurrency=1` os arquivos não se sobrepõem, então a soma se aproxima do
  // tempo do shard (o que sobra é a subida do processo e o setup do Postgres, que é por job).
  for (const [arquivo, fim] of ultimo) {
    yield `${JSON.stringify({ file: arquivo, ms: fim - primeiro.get(arquivo) })}\n`;
  }
}
