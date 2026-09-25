'use strict';

// Pré-carga SÓ para o benchmark local (node --require): conta consultas SQL e CPU/memória do processo do painel e as expõe em
// 127.0.0.1:BENCH_COUNTER_PORT. Não faz parte do produto e não é carregada pelo servidor normal. Recusa rodar fora de localhost.
const http = require('node:http');
const pg = require(require.resolve('pg', { paths: [process.cwd()] }));

const porta = Number(process.env.BENCH_COUNTER_PORT || 0);
if (!porta) throw new Error('bench-query-counter: defina BENCH_COUNTER_PORT');
let consultas = 0;
const original = pg.Client.prototype.query;
pg.Client.prototype.query = function contar(...args) {
  consultas += 1;
  return original.apply(this, args);
};

http.createServer((_req, res) => {
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ consultas, cpuMs: (cpu.user + cpu.system) / 1000, rssMb: mem.rss / 1048576, heapUsadoMb: mem.heapUsed / 1048576 }));
}).listen(porta, '127.0.0.1').unref();
