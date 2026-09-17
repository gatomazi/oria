// Reporter do `node --test` para o Second Tenant Gate (rodada 18, trilha D).
//
// Emite uma linha JSON por teste concluído, com o ARQUIVO de origem — o reporter TAP não diz de qual
// arquivo veio um teste que passou, e o gate precisa amarrar cada check a arquivos e nomes exatos.
// Também registra falhas de carga de arquivo (o runner as reporta como test:fail com o caminho no
// nome) e diagnósticos, para que "o arquivo nem rodou" nunca vire silêncio.

export default async function* reporterDoGate(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data || {};
    yield `${JSON.stringify({
      status: ev.type === 'test:pass' ? 'pass' : 'fail',
      file: d.file || null,
      name: d.name,
      nesting: d.nesting,
      skip: d.skip === undefined ? null : String(d.skip === true ? 'skip' : d.skip),
      todo: d.todo === undefined ? null : String(d.todo === true ? 'todo' : d.todo),
      tipo: d.details?.type || 'test',
      falha: ev.type === 'test:fail' ? String(d.details?.error?.failureType || 'testCodeFailure') : null,
    })}\n`;
  }
}
