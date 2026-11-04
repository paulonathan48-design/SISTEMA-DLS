'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../dls_demandas_coletivas.js');

function baseAggregate(modalidade) {
  return {
    demanda: {
      id: 'DLS-1',
      numero: 'DLS-2026-001',
      tipo: 'Aposentadoria',
      modalidade: modalidade || 'coletiva',
      responsavelId: 'CALC-1',
      status: 'andamento'
    },
    reclamantes: [
      { id: 'REC-1', nome: 'Ana Silva', legadoPrincipal: true, ordem: 0 },
      { id: 'REC-2', nome: 'Bia Souza', ordem: 1 }
    ],
    calculos: [
      {
        id: 'CLC-1', tipo: 'Aposentadoria', escopo: 'individual', reclamanteId: 'REC-1',
        calculistaExecutorId: 'CALC-1', status: 'pendente', ordem: 0
      },
      {
        id: 'CLC-2', tipo: 'Revisão', escopo: 'coletivo',
        calculistaExecutorId: 'CALC-2', status: 'andamento', ordem: 1
      }
    ],
    responsaveis: [
      { id: 'EQP-1', calculistaId: 'CALC-1', papel: 'principal', ativo: true },
      { id: 'EQP-2', calculistaId: 'CALC-2', papel: 'co_responsavel', ativo: true }
    ]
  };
}

test('normaliza modalidade, escopo e status de cálculo', () => {
  assert.equal(domain.normalizeModalidade('COLETIVA'), 'coletiva');
  assert.equal(domain.normalizeModalidade('outra'), 'individual');
  assert.equal(domain.normalizeScope('coletivo'), 'coletivo');
  assert.equal(domain.normalizeScope('x'), 'individual');
  assert.equal(domain.normalizeCalcStatus('atrasada'), 'andamento');
  assert.equal(domain.normalizeCalcStatus('ENTREGUE'), 'entregue');
  assert.equal(domain.normalizeCalcStatus('x'), 'pendente');
  assert.equal(domain.normalizeDemandStatus('ATRASADA'), 'atrasada');
});

test('agregado coletivo válido passa na validação', () => {
  const result = domain.validateDemandAggregate(baseAggregate());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.normalized.calculos.length, 2);
});

test('coletiva sem reclamante e sem cálculo é inválida', () => {
  const aggregate = baseAggregate();
  aggregate.reclamantes = [];
  aggregate.calculos = [];
  const result = domain.validateDemandAggregate(aggregate);
  assert.equal(result.valid, false);
  const codes = result.errors.map(e => e.code);
  assert.ok(codes.includes('COLETIVA_SEM_RECLAMANTE'));
  assert.ok(codes.includes('COLETIVA_SEM_CALCULO'));
});

test('individual com mais de um reclamante ativo é inválida', () => {
  const result = domain.validateDemandAggregate(baseAggregate('individual'));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'INDIVIDUAL_COM_VARIOS_RECLAMANTES'));
});

test('equipe exige exatamente um principal e não aceita duplicidade', () => {
  const semPrincipal = baseAggregate();
  semPrincipal.demanda.responsavelId = null;
  semPrincipal.responsaveis.forEach(r => { r.papel = 'co_responsavel'; });
  const r1 = domain.validateDemandAggregate(semPrincipal);
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some(e => e.code === 'PRINCIPAL_OBRIGATORIO'));

  const doisPrincipais = baseAggregate();
  doisPrincipais.responsaveis[1].papel = 'principal';
  const r2 = domain.validateDemandAggregate(doisPrincipais);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some(e => e.code === 'MAIS_DE_UM_PRINCIPAL'));

  const duplicado = baseAggregate();
  duplicado.responsaveis.push({ id: 'EQP-3', calculistaId: 'CALC-1', papel: 'co_responsavel', ativo: true });
  const r3 = domain.validateDemandAggregate(duplicado);
  assert.equal(r3.valid, false);
  assert.ok(r3.errors.some(e => e.code === 'CALCULISTA_DUPLICADO_NA_EQUIPE'));
});

test('executor de cálculo precisa pertencer à equipe ativa', () => {
  const aggregate = baseAggregate();
  aggregate.calculos[0].calculistaExecutorId = 'CALC-9';
  const result = domain.validateDemandAggregate(aggregate);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'EXECUTOR_FORA_DA_EQUIPE'));

  // Cálculo concluído pode manter o executor histórico fora da equipe atual.
  const concluido = baseAggregate();
  concluido.calculos[0] = {
    ...concluido.calculos[0],
    status: 'entregue',
    calculistaExecutorId: 'CALC-9',
    concluidoPorCalculistaId: 'CALC-2',
    concluidoEm: '2026-01-10T12:00:00Z',
    origemRegistro: 'novo'
  };
  const concluidoResult = domain.validateDemandAggregate(concluido);
  assert.equal(concluidoResult.valid, true, JSON.stringify(concluidoResult.errors));
});

test('cálculo coletivo não aponta reclamante e individual na coletiva exige reclamante', () => {
  const coletivoComRec = baseAggregate();
  coletivoComRec.calculos[1].reclamanteId = 'REC-1';
  const r1 = domain.validateDemandAggregate(coletivoComRec);
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some(e => e.code === 'CALCULO_COLETIVO_COM_RECLAMANTE'));

  const individualSemRec = baseAggregate();
  individualSemRec.calculos[0].reclamanteId = null;
  const r2 = domain.validateDemandAggregate(individualSemRec);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some(e => e.code === 'CALCULO_INDIVIDUAL_SEM_RECLAMANTE'));
});

test('crédito só existe em cálculo entregue com calculista e data', () => {
  const aberto = { status: 'andamento', concluidoPorCalculistaId: 'CALC-1', concluidoEm: '2026-10-01T12:00:00Z' };
  assert.equal(domain.calculationCredit(aberto), null);
  const semData = { status: 'entregue', concluidoPorCalculistaId: 'CALC-1' };
  assert.equal(domain.calculationCredit(semData), null);
  const concluido = { status: 'entregue', concluidoPorCalculistaId: 'CALC-1', concluidoEm: '2026-10-01T12:00:00Z' };
  assert.equal(domain.calculationCredit(concluido), 'CALC-1');
  assert.equal(domain.conclusionDate(concluido), '2026-10-01');

  // 00:30 UTC ainda é o dia anterior em America/Sao_Paulo.
  const madrugadaUtc = {
    status: 'entregue', concluidoPorCalculistaId: 'CALC-1',
    concluidoEm: '2026-10-06T00:30:00Z'
  };
  assert.equal(domain.conclusionDate(madrugadaUtc), '2026-10-05');
  assert.equal(domain.conclusionDate({ concluidoEm: '2026-10-05' }), '2026-10-05');
});

test('freezeConclusion é idempotente e bloqueia troca silenciosa de crédito', () => {
  const calculo = { id: 'CLC-1', status: 'andamento', calculistaExecutorId: 'CALC-1' };
  const congelado = domain.freezeConclusion(calculo, 'CALC-1', '2026-10-01T12:00:00Z');
  assert.equal(congelado.status, 'entregue');
  assert.equal(congelado.concluidoPorCalculistaId, 'CALC-1');
  const repetido = domain.freezeConclusion(congelado, 'CALC-1', '2026-10-02T12:00:00Z');
  assert.equal(repetido.concluidoEm, '2026-10-01T12:00:00Z');
  assert.throws(() => domain.freezeConclusion(congelado, 'CALC-2'), /outro calculista/i);
});

test('reopenCalculation limpa crédito e data', () => {
  const concluido = {
    id: 'CLC-1', status: 'entregue', calculistaExecutorId: 'CALC-1',
    concluidoPorCalculistaId: 'CALC-1', concluidoEm: '2026-10-01T12:00:00Z'
  };
  const aberto = domain.reopenCalculation(concluido, '2026-10-03T10:00:00Z', 'Ana', 'erro de conferência');
  assert.equal(aberto.status, 'andamento');
  assert.equal(aberto.concluidoPorCalculistaId, null);
  assert.equal(aberto.concluidoEm, null);
  assert.equal(aberto.reabertoPor, 'Ana');
  assert.equal(aberto.motivoReabertura, 'erro de conferência');
  assert.throws(() => domain.reopenCalculation(aberto), /concluídos/i);
});

test('métricas contam aberto pelo executor e concluído pelo crédito corrigido', () => {
  const demandasById = { 'DLS-1': { id: 'DLS-1', clienteId: 'CLI-1', prazo: '2026-10-10' } };
  const calculos = [
    {
      id: 'CLC-1', demandaId: 'DLS-1', tipo: 'Aposentadoria', status: 'entregue',
      calculistaExecutorId: 'CALC-2', concluidoPorCalculistaId: 'CALC-1',
      concluidoEm: '2026-10-05T12:00:00Z', ativo: true
    },
    {
      id: 'CLC-2', demandaId: 'DLS-1', tipo: 'Revisão', status: 'andamento',
      calculistaExecutorId: 'CALC-2', prazo: '2026-10-01', ativo: true
    },
    {
      id: 'CLC-3', demandaId: 'DLS-1', tipo: 'Revisão', status: 'pendente',
      calculistaExecutorId: 'CALC-3', ativo: true
    }
  ];
  const c1 = domain.calculationMetricsFor(calculos, { today: '2026-10-21', demandasById, calculistaId: 'CALC-1' });
  assert.equal(c1.concludedPeriod, 1);
  assert.equal(c1.concludedMonth, 1);
  assert.equal(c1.assignedOpen, 0);

  const c2 = domain.calculationMetricsFor(calculos, { today: '2026-10-21', demandasById, calculistaId: 'CALC-2' });
  assert.equal(c2.assignedOpen, 1);
  assert.equal(c2.overdue, 1);
  assert.equal(c2.concludedPeriod, 0, 'crédito corrigido não volta para o executor original');

  const periodo = domain.calculationMetricsFor(calculos, {
    today: '2026-10-21', demandasById, from: '2026-10-01', to: '2026-10-31'
  });
  assert.equal(periodo.concludedPeriod, 1);
  assert.equal(periodo.assignedOpen, 2);
  assert.equal(periodo.totalHistory, 1);

  const fora = domain.calculationMetricsFor(calculos, {
    today: '2026-10-21', demandasById, from: '2026-11-01', to: '2026-11-30'
  });
  assert.equal(fora.concludedPeriod, 0);

  const legadoSemData = domain.calculationMetricsFor([
    {
      id: 'CLC-LEG', demandaId: 'DLS-1', tipo: 'Revisão', status: 'entregue',
      calculistaExecutorId: 'CALC-1', concluidoPorCalculistaId: 'CALC-1', ativo: true
    }
  ], { today: '2026-10-21', demandasById, calculistaId: 'CALC-1', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(legadoSemData.totalHistory, 1, 'total histórico inclui crédito legado sem data');
  assert.equal(legadoSemData.historyWithoutDate, 1);
  assert.equal(legadoSemData.concludedPeriod, 0);
  assert.equal(legadoSemData.concludedMonth, 0);
});

test('prazo efetivo e atraso usam prazo do cálculo antes do prazo da demanda', () => {
  const calculo = { status: 'andamento', prazo: '2026-10-05' };
  const demanda = { prazo: '2026-10-20' };
  assert.equal(domain.effectiveDeadline(calculo, demanda), '2026-10-05');
  assert.equal(domain.calculationIsOverdue(calculo, demanda, new Date('2026-10-06T12:00:00Z')), true);
  assert.equal(domain.calculationIsOverdue({ ...calculo, status: 'entregue' }, demanda, new Date('2026-10-06T12:00:00Z')), false);
});

test('resumo e busca incluem todos os reclamantes e tipos de cálculo', () => {
  const aggregate = domain.normalizeDemandAggregate(baseAggregate());
  const demandaComFilhos = {
    ...aggregate.demanda,
    reclamantes: aggregate.reclamantes,
    calculos: aggregate.calculos,
    responsaveis: aggregate.responsaveis
  };
  const resumo = domain.summarizeReclamantes(demandaComFilhos);
  assert.equal(resumo.modalidade, 'coletiva');
  assert.equal(resumo.count, 2);
  assert.equal(resumo.calculationCount, 2);
  assert.deepEqual(resumo.names, ['Ana Silva', 'Bia Souza']);
  const texto = domain.searchableText(demandaComFilhos);
  assert.match(texto, /ana silva/);
  assert.match(texto, /bia souza/);
  assert.match(texto, /revisão/);
});

test('buildTeamFromIds preserva IDs existentes e define um principal', () => {
  const equipe = domain.buildTeamFromIds(['CALC-1', 'CALC-2', 'CALC-2'], 'CALC-2', [
    { id: 'EQP-1', calculistaId: 'CALC-1', papel: 'co_responsavel', ativo: true }
  ], new Date('2026-10-01T12:00:00Z'));
  assert.equal(equipe.length, 2);
  assert.equal(equipe.find(r => r.calculistaId === 'CALC-1').id, 'EQP-1');
  assert.equal(equipe.find(r => r.calculistaId === 'CALC-2').papel, 'principal');
});

test('conversão legada cria reclamante, cálculo e equipe sem inventar crédito', () => {
  const agregado = domain.demandAggregateFromLegacy({
    id: 'DLS-9', numero: 'DLS-2026-009', tipo: 'Cálculo', status: 'entregue',
    responsavelId: 'CALC-1', reclamante: 'João Pereira', concluidaEm: '2026-01-02T12:00:00Z'
  });
  assert.equal(agregado.reclamantes.length, 1);
  assert.equal(agregado.calculos.length, 1);
  assert.equal(agregado.responsaveis.length, 1);
  assert.equal(agregado.calculos[0].origemRegistro, 'legado');
  assert.equal(agregado.calculos[0].creditoLegadoPresumido, true);
  assert.equal(domain.calculationCredit(agregado.calculos[0]), 'CALC-1');
  assert.equal(agregado.calculos[0].concluidoEm, '2026-01-02T12:00:00Z');

  const semReclamante = domain.demandAggregateFromLegacy({
    id: 'DLS-10', numero: 'DLS-2026-010', tipo: 'Cálculo', status: 'pendente',
    responsavelId: 'CALC-1', reclamante: ''
  });
  assert.equal(semReclamante.reclamantes.length, 0);
  assert.equal(semReclamante.calculos[0].legadoSemReclamante, true);
});

test('backup v5 válido é aceito e referência cruzada é rejeitada', () => {
  const aggregate = domain.normalizeDemandAggregate(baseAggregate());
  const payload = {
    demandas: [aggregate.demanda],
    reclamantes: aggregate.reclamantes,
    calculos: aggregate.calculos,
    responsaveis: aggregate.responsaveis
  };
  const ok = domain.validateBackupPayload(payload);
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const outra = domain.normalizeDemandAggregate({
    ...baseAggregate('individual'),
    demanda: { ...baseAggregate('individual').demanda, id: 'DLS-2', numero: 'DLS-2026-002' },
    reclamantes: [{ id: 'REC-9', nome: 'Outra Pessoa', legadoPrincipal: true }],
    calculos: [{ id: 'CLC-9', tipo: 'Cálculo', escopo: 'individual', reclamanteId: 'REC-9', calculistaExecutorId: 'CALC-1' }]
  });
  const cruzado = {
    demandas: [aggregate.demanda, outra.demanda],
    reclamantes: [...aggregate.reclamantes, ...outra.reclamantes],
    calculos: [
      ...aggregate.calculos,
      { ...aggregate.calculos[0], id: 'CLC-X', reclamanteId: 'REC-9' },
      ...outra.calculos
    ],
    responsaveis: [...aggregate.responsaveis, ...outra.responsaveis]
  };
  const invalido = domain.validateBackupPayload(cruzado);
  assert.equal(invalido.valid, false);
  assert.ok(invalido.errors.some(e => e.code === 'RECLAMANTE_DE_OUTRA_DEMANDA' || e.code === 'BACKUP_RECLAMANTE_CRUZADO'));

  const referencia = domain.validateBackupPayload({
    demandas: [],
    reclamantes: [{ id: 'REC-1', demandaId: 'DLS-404', nome: 'Órfã' }],
    calculos: [],
    responsaveis: []
  });
  assert.equal(referencia.valid, false);
  assert.ok(referencia.errors.some(e => e.code === 'BACKUP_REFERENCIA_INVALIDA'));
});

test('backup rejeita IDs duplicados, vazios e espelhamento ambíguo', () => {
  const aggregate = domain.normalizeDemandAggregate(baseAggregate());
  const espelhado = {
    demandas: [{
      ...aggregate.demanda,
      reclamantes: aggregate.reclamantes,
      calculos: aggregate.calculos,
      responsaveis: aggregate.responsaveis
    }],
    reclamantes: aggregate.reclamantes,
    calculos: aggregate.calculos,
    responsaveis: aggregate.responsaveis
  };
  const mirror = domain.validateBackupPayload(espelhado);
  assert.equal(mirror.valid, true, JSON.stringify(mirror.errors));

  const duplicada = domain.validateBackupPayload({
    demandas: [aggregate.demanda, { ...aggregate.demanda, numero: 'OUTRA' }],
    reclamantes: aggregate.reclamantes,
    calculos: aggregate.calculos,
    responsaveis: aggregate.responsaveis
  });
  assert.equal(duplicada.valid, false);
  assert.ok(duplicada.errors.some(e => e.code === 'BACKUP_DEMANDA_DUPLICADA'));

  const filhoDuplicado = domain.validateBackupPayload({
    demandas: [aggregate.demanda],
    reclamantes: [...aggregate.reclamantes, { ...aggregate.reclamantes[0] }],
    calculos: aggregate.calculos,
    responsaveis: aggregate.responsaveis
  });
  assert.equal(filhoDuplicado.valid, false);
  assert.ok(filhoDuplicado.errors.some(e => e.code === 'BACKUP_FILHO_DUPLICADO'));

  const filhoSemId = domain.validateBackupPayload({
    demandas: [aggregate.demanda],
    reclamantes: [{ nome: 'Sem ID', demandaId: aggregate.demanda.id }],
    calculos: aggregate.calculos,
    responsaveis: aggregate.responsaveis
  });
  assert.equal(filhoSemId.valid, false);
  assert.ok(filhoSemId.errors.some(e => e.code === 'BACKUP_FILHO_SEM_ID'));

  const cruzadoEmbutido = domain.validateBackupPayload({
    demandas: [
      { ...aggregate.demanda, reclamantes: aggregate.reclamantes },
      { ...aggregate.demanda, id: 'DLS-2', numero: 'DLS-2026-002', reclamantes: [{ ...aggregate.reclamantes[0] }] }
    ],
    reclamantes: [],
    calculos: [],
    responsaveis: []
  });
  assert.equal(cruzadoEmbutido.valid, false);
  assert.ok(cruzadoEmbutido.errors.some(e => e.code === 'BACKUP_FILHO_CRUZADO'));
});

test('distingue backup v5 de backup legado versão 2 sem filhos', () => {
  const legado = {
    versao: 2,
    migracaoV5: false,
    demandas: [{
      id: 'DLS-1', numero: 'DLS-2026-001', tipo: 'Cálculo',
      modalidade: 'individual', reclamantes: [], calculos: [], responsaveis: []
    }]
  };
  assert.equal(domain.backupLooksLikeV5(legado), false);

  assert.equal(domain.backupLooksLikeV5({
    versao: 2,
    migracaoV5: true,
    demandas: []
  }), true);

  assert.equal(domain.backupLooksLikeV5({
    versao: 2,
    migracaoV5: false,
    demandas: [{ ...legado.demandas[0], modalidade: 'coletiva', reclamantes: [] }]
  }), true);

  assert.equal(domain.backupLooksLikeV5({
    demandas: [legado.demandas[0]],
    reclamantes: [{ id: 'REC-1', demandaId: 'DLS-1', nome: 'Ana' }]
  }), true);

  assert.equal(domain.backupLooksLikeV5({
    demandas: [{
      ...legado.demandas[0],
      calculos: [{ id: 'CLC-1', tipo: 'Cálculo' }]
    }]
  }), true);
});

test('escapeHtml protege campos livres', () => {
  assert.equal(domain.escapeHtml('<img src=x onerror="1">'), '&lt;img src=x onerror=&quot;1&quot;&gt;');
  assert.equal(domain.escapeHtml("O'Reilly & Cia"), 'O&#39;Reilly &amp; Cia');
});

test('números inválidos não viram crédito ou valor zero silencioso', () => {
  const normalizado = domain.normalizeCalculation({ valorResultado: 'abc', status: 'pendente' }, 0, 'DLS-1');
  assert.equal(normalizado.valorResultado, null);
  const demanda = domain.normalizeDemandAggregate({
    demanda: { id: 'DLS-1', numero: 'X', tipo: 'T', valorEstimado: 'abc' }
  });
  assert.equal(demanda.demanda.valorEstimado, null);
});
