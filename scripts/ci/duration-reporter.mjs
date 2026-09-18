// Reporter do `node --test` que grava a duração de cada teste com o arquivo de origem.
//
// Serve só para BALANCEAR shards (scripts/ci/suites.mjs): nenhuma decisão de gate depende disto.
// O reporter do gate (apps/panel/scripts/productization/gate-reporter.mjs) é outro e continua
// intocado — ele responde por "o teste rodou", que é contrato; este responde por "quanto demorou".

export default async function* reporterDeDuracao(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data || {};
    if (!d.file || d.nesting !== 0) continue;
    yield `${JSON.stringify({ file: d.file, ms: Math.round(d.details?.duration_ms ?? 0) })}\n`;
  }
}
