#!/usr/bin/env node
// Fase 6 · Tenant #1 — orquestrador (local). PHASE 6 CLOSED não é decidido aqui.
//
//   npm run tenant1:preflight -- --scenario A|B --mapping <arquivo> --uploads <dir> [--app-role oria_app] [--rollout]
//   (--rollout é obrigatório quando o arquivo declara rollout: true — alvo = cenário B, rodada 19)
//   --estagio antes-da-b   preflight/plan SEM banco: o ambiente que o pre-deploy da RELEASE B (31a7cdb)
//                          vai ler é o que o arquivo declara; imprime os valores esperados
//   --estagio release-b    verify contra o schema publicado pela RELEASE B
//   npm run tenant1:plan      -- (mesmos argumentos)
//   npm run tenant1:apply     -- (mesmos) [--saida-segredos <dir>]       só banco local
//   npm run tenant1:verify    -- (mesmos)
//   npm run tenant1:rollback  -- --scenario A|B --mapping <arquivo> [--snapshot <arquivo>] [--aplicar]
//
// DATABASE_URL = role de migration. preflight, plan e verify abrem a sessão READ ONLY.
// Saída: uma linha por item (PASS/FAIL/PEND/INFO) e `RESULTADO <comando>: PASS|FAIL`. Exit 0 só com PASS.
// Segredo nenhum vai para o stdout; se algum valor sensível do ambiente aparecer, a linha é
// mascarada e a execução termina com erro.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  lerArgs, exigirCenarioEArquivo, criarSaida, imprimirItens, resultado, urlSomenteLeitura, Tenant1Error, ESTAGIOS, RELEASE_B,
} from './config.mjs';
import { coletar, conferirAntesDaB, valoresDaReleaseB } from './checks.mjs';
import { planejar, aplicar, reverter, ALAVANCAS_ROLLBACK } from './acoes.mjs';

const COMANDOS = ['preflight', 'plan', 'apply', 'verify', 'rollback'];

export async function executar(comando, argv, { env = process.env, escrever } = {}) {
  const saida = criarSaida({ env, escrever });
  const fim = (res) => {
    const final = saida.estado.vazou ? 'FAIL' : res;
    if (saida.estado.vazou) saida.linha('FAIL saida.segredo — um valor sensível do ambiente apareceu na saída (mascarado)');
    saida.linha(`RESULTADO ${comando}: ${final}`);
    return { codigo: final === 'PASS' ? 0 : 1, linhas: saida.estado.linhas };
  };
  try {
    if (!COMANDOS.includes(comando)) throw new Tenant1Error(`comando desconhecido: ${comando}`);
    const args = lerArgs(argv);
    const estagio = args.estagio || 'head';
    if (!ESTAGIOS[estagio]) throw new Tenant1Error(`--estagio precisa ser ${Object.keys(ESTAGIOS).join(', ')} (recebi ${estagio})`);
    if (!ESTAGIOS[estagio].includes(comando)) throw new Tenant1Error(`--estagio ${estagio} só vale para: ${ESTAGIOS[estagio].join(', ')}`);
    const cfg = exigirCenarioEArquivo(args);
    if (estagio === 'antes-da-b') {
      // Sem banco: o schema de produção ainda é o anterior à RELEASE B.
      saida.linha(`tenant1 ${comando} · cenário ${cfg.cenario} · ${cfg.organizations.length} Organization(s) · ${cfg.rollout ? 'ALVO DE ROLLOUT' : 'ensaio'} · antes da RELEASE B (${RELEASE_B.commit}), sem banco`);
      const itens = conferirAntesDaB({ cfg, env });
      imprimirItens(saida, itens);
      for (const l of valoresDaReleaseB(cfg)) saida.linha(l);
      return fim(resultado(itens));
    }
    const url = String(env.DATABASE_URL || '').trim();
    if (!url) throw new Tenant1Error('DATABASE_URL ausente');
    const base = { url, cfg, env, uploads: args.uploads || null, appRole: args.appRole || 'oria_app' };
    saida.linha(`tenant1 ${comando} · cenário ${cfg.cenario} · ${cfg.organizations.length} Organization(s) · ${cfg.rollout ? 'ALVO DE ROLLOUT' : 'ensaio'}`);

    if (comando === 'preflight' || comando === 'verify') {
      if (estagio === 'release-b') saida.linha(`schema esperado: RELEASE B (${RELEASE_B.commit}, até ${RELEASE_B.ultimaMigration})`);
      const itens = await coletar({ ...base, url: urlSomenteLeitura(url), modo: comando, estagio });
      imprimirItens(saida, itens);
      return fim(resultado(itens));
    }
    if (comando === 'plan') {
      const { itens, linhas } = await planejar(base);
      for (const l of linhas) saida.linha(l);
      imprimirItens(saida, itens.filter((i) => i.status === 'FAIL' || i.status === 'INFO'));
      return fim(resultado(itens));
    }
    if (comando === 'apply') {
      const r = await aplicar({ ...base, saidaSegredos: args.saidaSegredos || null });
      if (r.abortado) {
        imprimirItens(saida, r.preflight.filter((i) => i.status !== 'PASS'));
        imprimirItens(saida, r.passos);
        saida.linha(r.passos.length ? 'apply abortado no meio: os passos anteriores são idempotentes; corrija e rode de novo' : 'apply abortado pelo preflight: nada foi escrito');
        return fim('FAIL');
      }
      imprimirItens(saida, r.passos);
      saida.linha('verify:');
      imprimirItens(saida, r.verify);
      return fim(resultado([...r.passos, ...r.verify]));
    }
    // rollback
    const r = await reverter({ url, cfg, env, aplicar: args.aplicar });
    imprimirItens(saida, r.itens);
    if (args.snapshot) {
      fs.writeFileSync(args.snapshot, `${JSON.stringify({ antes: r.antes, depois: r.depois }, null, 2)}\n`, { mode: 0o600 });
      saida.linha(`impressão digital gravada em ${args.snapshot}`);
    }
    saida.linha(r.aplicado ? 'alavancas de configuração a ligar (valores ficam no ambiente, não aqui):' : 'simulação: nada foi escrito (use --aplicar). Alavancas:');
    for (const a of ALAVANCAS_ROLLBACK) saida.linha(`  - ${a}`);
    return fim(resultado(r.itens));
  } catch (err) {
    const msg = err instanceof Tenant1Error ? err.message : `erro: ${err.message}`;
    for (const l of msg.split('\n')) saida.linha(`FAIL ${l}`);
    return fim('FAIL');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [comando, ...resto] = process.argv.slice(2);
  executar(comando, resto).then(
    (r) => process.exit(r.codigo),
    (err) => { process.stderr.write(`tenant1: ${err.message}\n`); process.exit(1); }
  );
}
