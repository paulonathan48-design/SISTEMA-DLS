'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('data histórica global só é enviada no caminho de restauração', () => {
  assert.match(html, /demandaToRow\(item, incluirConclusao = false\)/);
  assert.match(html, /demandaToRow\(demanda, options\.incluirConclusao === true\)/);

  const calls = html.match(/DB\.saveDemandaCompleta\([^\n]*\);/g) || [];
  const comData = calls.filter(c => c.includes('incluirConclusao: true'));
  const semData = calls.filter(c => !c.includes('incluirConclusao'));
  assert.equal(calls.length, 3);
  assert.equal(comData.length, 2, 'importação v5 e conversão legada restauram a data');
  assert.equal(semData.length, 1, 'edição comum não sobrescreve concluida_em');
  assert.match(html, /salva = DB\.saveDemandaCompleta\(normalizado\.demanda[^\n]*\);/);
  assert.doesNotMatch(html, /salva = DB\.saveDemandaCompleta\(normalizado\.demanda[^\n]*incluirConclusao/);
});

test('falha de carga dos filhos não é renderizada/exportada como lista vazia', () => {
  assert.match(html, /if \(DB\._coletivasLoadError\) \{\s*kpis\.innerHTML[\s\S]*?Nenhum total foi calculado/);
  assert.match(html, /Falha ao carregar os cálculos\. A exportação não foi gerada para não produzir totais vazios/);
  assert.match(html, /const totalCalculos = domainOk \? calcsAtivos\.length : '—'/);
});

test('exportação XLSX contém abas detalhadas de reclamantes e equipe', () => {
  assert.match(html, /addSheetStd\('Reclamantes', 'DLS - Reclamantes por demanda'/);
  assert.match(html, /addSheetStd\('Equipe', 'DLS - Equipe por demanda'/);
  assert.match(html, /addSheetStd\('Calculos', 'DLS - Produção de cálculos/);
});

test('exportação XLSX declara o domínio antes do primeiro uso no callback de demandas', () => {
  const start = html.indexOf('function exportarRelatorio()');
  assert.ok(start >= 0);
  const end = html.indexOf('\n    function ', start + 10);
  assert.ok(end > start);
  const fn = html.slice(start, end);
  const declaracao = fn.indexOf('const domain = window.DLSDomain;');
  const primeiroUso = fn.indexOf('domain && DB.relatedDataReady()');
  assert.ok(declaracao > 0, 'domain precisa ser declarado no início da exportação');
  assert.ok(primeiroUso > declaracao, 'domain não pode ser usado antes da declaração (TDZ)');
  assert.equal(fn.match(/const domain = window\.DLSDomain;/g).length, 1);
});

test('carga inicial pagina as tabelas para não truncar filhos acima do limite do PostgREST', () => {
  assert.match(html, /selectAll\(table, query = \{\}, pageSize = 500\)/);
  assert.match(html, /this\.selectAll\('dls_demandas', \{ order: 'criado_em\.desc\.nullslast,numero\.desc,id\.desc' \}\)/);
  for (const table of ['dls_demanda_reclamantes', 'dls_demanda_calculos', 'dls_demanda_responsaveis']) {
    assert.match(html, new RegExp(`this\\.selectAll\\('${table}'`));
  }
  assert.match(html, /offset: String\(offset\)/);
  assert.match(html, /if \(page\.length < pageSize\) break;/);
});

test('tabela de produção de cálculos tem cabeçalho compatível com as colunas renderizadas', () => {
  const body = html.indexOf('id="calcProdTable"');
  assert.ok(body > 0);
  const headStart = html.lastIndexOf('<thead>', body);
  const head = html.slice(headStart, body);
  assert.equal((head.match(/<th>/g) || []).length, 9);
  for (const label of ['Concluídos no período', 'Concluídos hoje', 'Concluídos no mês', 'Total histórico', 'Detalhe']) {
    assert.match(head, new RegExp(label));
  }
});

test('reset é bloqueado quando a estrutura v5 existe', () => {
  const start = html.indexOf('function resetarDB()');
  assert.ok(start >= 0);
  const trecho = html.slice(start, start + 900);
  assert.match(trecho, /if \(DB\.hasColetivas\(\)\)/);
  assert.match(trecho, /Reset desativado após a migração v5/);
  assert.match(trecho, /return;/);
});
