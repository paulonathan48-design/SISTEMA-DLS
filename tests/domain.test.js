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

  // A data de recebimento e a data oficial de conclusão da demanda também
  // precisam usar o fuso de Brasília quando vêm de timestamps.
  assert.equal(
    domain.receivedDate({ criadoEm: '2026-10-06T00:30:00Z' }),
    '2026-10-05'
  );
  assert.equal(
    domain.receivedDate({ dataRequisicao: '2026-10-06', criadoEm: '2026-10-07T00:30:00Z' }),
    '2026-10-06'
  );
  assert.equal(
    domain.demandConclusionDate({ concluidaEm: '2026-10-06T00:30:00Z' }),
    '2026-10-05'
  );
  assert.equal(
    domain.demandConclusionDate({ concluidaEm: '2026-10-06' }),
    '2026-10-06'
  );

  // Timestamp sem fuso vindo do banco é UTC (gravado por datetimeIn/now()).
  assert.equal(domain.dateOnly('2026-10-06 00:30:00'), '2026-10-05');
  assert.equal(domain.timestampDateOnly('2026-10-06 00:30:00'), '2026-10-05');
  assert.equal(domain.dateOnly('2026-10-06T00:30:00Z'), '2026-10-05');
  assert.equal(domain.dateOnly('2026-10-06'), '2026-10-06');
  assert.equal(domain.dateOnly('06/10/2026'), '2026-10-06');

  // Exibição e input datetime-local sempre no horário oficial de Brasília.
  assert.equal(domain.formatDateBR('2026-10-06T00:30:00Z'), '05/10/2026');
  assert.equal(domain.toSaoPauloInput('2026-10-06T00:30:00Z'), '2026-10-05T21:30');
  assert.equal(domain.formatTimeBR('2026-10-06T00:30:00Z'), '21:30');
  assert.match(domain.formatDateTimeBR('2026-10-06T00:30:00Z'), /^05\/10\/2026[, ]+21:30:00$/);

  const reuniaoUtc = domain.fromSaoPauloInput('2026-11-13T14:00');
  assert.equal(reuniaoUtc, '2026-11-13T17:00:00.000Z');
  assert.equal(domain.toSaoPauloInput(reuniaoUtc), '2026-11-13T14:00');

  assert.equal(domain.isoAddDays('2026-12-31', 1), '2027-01-01');
  assert.equal(domain.isoAddDays('2028-02-28', 1), '2028-02-29');
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

  const conclusaoOrfa = domain.validateBackupPayload({
    demandas: [aggregate.demanda],
    conclusoes: [{ id: 'CONC-ORFA', tipoConclusao: 'concordancia' }],
    impugnacaoItens: []
  });
  assert.equal(conclusaoOrfa.valid, false);
  assert.ok(conclusaoOrfa.errors.some(e => e.code === 'BACKUP_REFERENCIA_INVALIDA'));

  const itemOrfao = domain.validateBackupPayload({
    demandas: [aggregate.demanda],
    conclusoes: [],
    impugnacaoItens: [{ id: 'IMP-ORFAO', conclusaoId: 'CONC-1' }]
  });
  assert.equal(itemOrfao.valid, false);
  assert.ok(itemOrfao.errors.some(e => e.code === 'BACKUP_REFERENCIA_INVALIDA'));

  const conclusaoTopDuplicada = domain.validateBackupPayload({
    demandas: [aggregate.demanda],
    conclusoes: [
      { id: 'CONC-1', demandaId: aggregate.demanda.id, tipoConclusao: 'concordancia', versao: 1, situacao: 'vigente' },
      { id: 'CONC-1', demandaId: aggregate.demanda.id, tipoConclusao: 'concordancia', versao: 2, situacao: 'substituida' }
    ]
  });
  assert.equal(conclusaoTopDuplicada.valid, false);
  assert.ok(conclusaoTopDuplicada.errors.some(e => e.code === 'BACKUP_FILHO_DUPLICADO'));
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

test('tipos canônicos corrigem Cálculo Civil e aceitam E-Social sem apagar tipos livres', () => {
  assert.ok(domain.CALC_TYPES.includes('Cálculo Cível'));
  assert.ok(domain.CALC_TYPES.includes('E-Social'));
  assert.equal(domain.normalizeCalcType('Cálculo Civil'), 'Cálculo Cível');
  assert.equal(domain.normalizeCalcType('calculo civel'), 'Cálculo Cível');
  assert.equal(domain.normalizeCalcType('E Social'), 'E-Social');
  assert.equal(domain.normalizeCalcType('ESocial'), 'E-Social');
  assert.equal(domain.normalizeCalcType('e_social'), 'E-Social');
  assert.equal(domain.normalizeCalcType('Cálculo Personalizado'), 'Cálculo Personalizado');
});

test('classificação de conclusão valida impugnação item a item sem total consolidado', () => {
  const calculos = [{ id: 'CLC-1', tipo: 'Cálculo Cível', status: 'entregue', reclamanteId: 'REC-1', escopo: 'individual' }];
  const reclamantes = [{ id: 'REC-1', nome: 'Ana' }];

  const semTipo = domain.validateConclusionInput({ itens: [], calculos, reclamantes });
  assert.equal(semTipo.valid, false);
  assert.ok(semTipo.errors.some(e => e.code === 'CONCLUSAO_TIPO_OBRIGATORIO'));

  const impugnacaoSemItem = domain.validateConclusionInput({ tipoConclusao: 'impugnacao', itens: [], calculos, reclamantes });
  assert.equal(impugnacaoSemItem.valid, false);
  assert.ok(impugnacaoSemItem.errors.some(e => e.code === 'IMPUGNACAO_SEM_COMPARACAO'));

  const concordanciaComItem = domain.validateConclusionInput({
    tipoConclusao: 'concordancia',
    itens: [{ calculoId: 'CLC-1', valorDls: 100, valorOutraParte: 50 }],
    calculos,
    reclamantes
  });
  assert.equal(concordanciaComItem.valid, false);
  assert.ok(concordanciaComItem.errors.some(e => e.code === 'CONCLUSAO_IMPUGNACAO_INDEVIDA'));

  const valida = domain.validateConclusionInput({
    tipoConclusao: 'Impugnação',
    itens: [
      { calculoId: 'CLC-1', valorDls: '1.200,50', valorOutraParte: '1.000,00', descricao: 'Verba A' },
      { escopo: 'coletivo_geral', valorDls: 500, valorOutraParte: 500, descricao: 'Honorários' }
    ],
    calculos,
    reclamantes
  });
  assert.equal(valida.valid, true, JSON.stringify(valida.errors));
  assert.equal(valida.normalized.tipoConclusao, 'impugnacao');
  assert.equal(valida.normalized.itens.length, 2);
  assert.equal(valida.normalized.itens[0].reclamanteId, 'REC-1');
  assert.equal(valida.normalized.itens[0].diferencaAssinada, 200.5);
  assert.equal(valida.normalized.itens[0].diferencaAbsoluta, 200.5);
  assert.equal(valida.normalized.itens[0].direcao, 'DLS maior');
  assert.equal(valida.normalized.itens[1].diferencaAssinada, 0);
  assert.equal(valida.normalized.itens[1].direcao, 'Valores iguais');
  assert.ok(!Object.prototype.hasOwnProperty.call(valida.normalized, 'valorTotal'));
});

test('analytics de período e filtros contam demandas uma vez e cálculos pelo executor creditado', () => {
  const demandas = [
    {
      id: 'DLS-1', numero: 'DLS-2026-001', processo: '0001', chamado: 'CH-1',
      tipo: 'Cálculo Cível', modalidade: 'coletiva', clienteId: 'CLI-1',
      status: 'entregue', prazo: '2026-10-10', dataRequisicao: '2026-10-01',
      concluidaEm: '2026-10-20T12:00:00Z', responsavelId: 'CALC-1',
      reclamantes: [
        { id: 'REC-1', nome: 'Ana' },
        { id: 'REC-2', nome: 'Bia' },
        { id: 'REC-3', nome: 'Carla' }
      ],
      calculos: [],
      responsaveis: [
        { calculistaId: 'CALC-1', papel: 'principal', ativo: true },
        { calculistaId: 'CALC-2', papel: 'co_responsavel', ativo: true }
      ],
      conclusoes: [{
        id: 'CONC-1', situacao: 'vigente', tipoConclusao: 'impugnacao',
        concluidaEm: '2026-10-20T12:00:00Z'
      }],
      impugnacaoItens: [
        { id: 'IMP-1', conclusaoId: 'CONC-1', direcao: 'DLS maior' },
        { id: 'IMP-2', conclusaoId: 'CONC-1', direcao: 'Outra parte maior' }
      ]
    },
    {
      id: 'DLS-2', numero: 'DLS-2026-002', processo: '0002',
      tipo: 'Cálculo Trabalhista', modalidade: 'individual', clienteId: 'CLI-2',
      status: 'andamento', prazo: '2026-10-15', dataRequisicao: '2026-11-01',
      responsavelId: 'CALC-3',
      reclamantes: [{ id: 'REC-4', nome: 'Dora' }],
      calculos: [],
      responsaveis: [{ calculistaId: 'CALC-3', papel: 'principal', ativo: true }],
      conclusoes: [],
      impugnacaoItens: []
    }
  ];
  const calculos = [
    { id: 'CLC-1', demandaId: 'DLS-1', tipo: 'Cálculo Cível', status: 'entregue', ativo: true, calculistaExecutorId: 'CALC-2', concluidoPorCalculistaId: 'CALC-2', concluidoEm: '2026-10-15T12:00:00Z', createdAt: '2026-10-02T10:00:00Z' },
    { id: 'CLC-2', demandaId: 'DLS-1', tipo: 'E-Social', status: 'entregue', ativo: true, calculistaExecutorId: 'CALC-1', concluidoPorCalculistaId: 'CALC-1', concluidoEm: '2026-10-16T12:00:00Z', createdAt: '2026-10-03T10:00:00Z' },
    { id: 'CLC-3', demandaId: 'DLS-2', tipo: 'Cálculo Trabalhista', status: 'andamento', ativo: true, calculistaExecutorId: 'CALC-3', createdAt: '2026-11-01T10:00:00Z' }
  ];
  const period = { preset: 'personalizado', from: '2026-10-01', to: '2026-10-31', label: 'Outubro/2026' };
  const now = new Date('2026-11-05T12:00:00Z');
  const analytics = domain.buildDemandAnalytics(demandas, { period, now, calculos });

  assert.equal(analytics.totalSelected, 2, 'não multiplica por reclamantes, cálculos ou equipe');
  assert.deepEqual(analytics.selectedIds, ['DLS-1', 'DLS-2']);
  assert.equal(analytics.receivedCount, 1);
  assert.equal(analytics.individualReceived, 0);
  assert.equal(analytics.collectiveReceived, 1);
  assert.equal(analytics.claimantsDistinct, 3, 'reclamantes distintos apenas das demandas recebidas');
  assert.equal(analytics.concludedCount, 1);
  assert.equal(analytics.openCount, 1);
  assert.equal(analytics.overdueCount, 1, 'posição atual independe do período de recebimento');
  assert.equal(analytics.sla, 0, 'concluída com atraso e uma aberta atrasada');
  assert.equal(analytics.concludedOnTime, 0);
  assert.equal(analytics.concludedLate, 1);
  assert.equal(analytics.overdueCount, 1);
  assert.equal(analytics.slaSample, 2, 'SLA inclui conclusões e atrasos em aberto uma única vez');
  assert.equal(analytics.legacyDeliveredWithoutDate, 0);
  assert.deepEqual(analytics.typeCounts, { 'Cálculo Cível': 1 });
  assert.deepEqual(analytics.conclusionTypeCounts, { 'Impugnação': 1 });
  assert.equal(analytics.impugnacaoItensCount, 2);
  assert.deepEqual(analytics.series.received, [1]);
  assert.deepEqual(analytics.series.receivedCollective, [1]);
  assert.deepEqual(analytics.series.concluded, [1]);
  assert.deepEqual(analytics.series.calculations, [2]);
  assert.deepEqual(analytics.series.calculationsCreated, [2]);
  assert.equal(analytics.calculations.calendarTotal, 3);
  assert.equal(analytics.calculations.createdPeriod, 2);
  assert.equal(analytics.calculations.concludedPeriod, 2);
  assert.equal(analytics.calculations.openAssigned, 1);
  assert.equal(analytics.calculations.overdue, 1);
  assert.deepEqual(analytics.calculations.executorCounts, { 'CALC-2': 1, 'CALC-1': 1 });
  assert.deepEqual(analytics.calculations.statusCounts, { pendente: 0, andamento: 1, revisao: 0, aguardando: 0, entregue: 2, cancelada: 0 });
  assert.deepEqual(analytics.calculations.typeCounts, { 'Cálculo Cível': 1, 'E-Social': 1 });
  assert.deepEqual(analytics.calculations.modalityCounts, { individual: 0, coletiva: 2 });

  const porExecutor = domain.buildDemandAnalytics(demandas, { period, now, calculos, calcExecutorId: 'CALC-2' });
  assert.deepEqual(porExecutor.selectedIds, ['DLS-1']);
  assert.deepEqual(porExecutor.calculations.executorCounts, { 'CALC-2': 1 });
  assert.equal(porExecutor.calculations.createdPeriod, 1);
  assert.equal(porExecutor.calculations.concludedPeriod, 1);

  const porStatusCalculo = domain.buildDemandAnalytics(demandas, { period, now, calculos, calcStatus: 'andamento' });
  assert.deepEqual(porStatusCalculo.selectedIds, ['DLS-2']);
  assert.equal(porStatusCalculo.receivedCount, 0);
  assert.equal(porStatusCalculo.openCount, 1);
  assert.equal(porStatusCalculo.calculations.concludedPeriod, 0);

  const porConclusao = domain.buildDemandAnalytics(demandas, { period, now, calculos, conclusionType: 'impugnacao' });
  assert.deepEqual(porConclusao.selectedIds, ['DLS-1']);
  const semClassificacao = domain.buildDemandAnalytics(demandas, { period, now, calculos, conclusionType: 'sem_classificacao' });
  assert.equal(semClassificacao.totalSelected, 0, 'demanda aberta sem conclusão não é legado entregue');
  const semClassificacaoAberta = domain.buildDemandAnalytics([demandas[1]], { period, now, calculos, conclusionType: 'sem_classificacao' });
  assert.equal(semClassificacaoAberta.totalSelected, 0);

  const porResponsavel = domain.buildDemandAnalytics(demandas, { period, now, calculos, responsavelId: 'CALC-2' });
  assert.deepEqual(porResponsavel.selectedIds, ['DLS-1'], 'co-responsável ativo entra no filtro');
  const busca = domain.buildDemandAnalytics(demandas, { period, now, calculos, search: '0002' });
  assert.deepEqual(busca.selectedIds, ['DLS-2']);

  const semAmostra = domain.buildDemandAnalytics([], { period, now, calculos: [] });
  assert.equal(semAmostra.sla, null, 'sem amostra o SLA não pode ser 100% artificial');
  assert.equal(semAmostra.slaSample, 0);

  const demandasTrimestre = [
    { id: 'T1', modalidade: 'individual', status: 'pendente', dataRequisicao: '2026-01-05' },
    { id: 'T2', modalidade: 'coletiva', status: 'pendente', dataRequisicao: '2026-04-10' },
    { id: 'T3', modalidade: 'individual', status: 'pendente', dataRequisicao: '2026-08-20' }
  ];
  const periodAno = { preset: 'personalizado', from: '2026-01-01', to: '2026-12-31', label: '2026' };
  const trimestral = domain.buildDemandAnalytics(demandasTrimestre, {
    period: periodAno, now, calculos: [], granularity: 'trimestral'
  });
  assert.deepEqual(trimestral.buckets.map(b => b.key), ['2026-T1', '2026-T2', '2026-T3', '2026-T4']);
  assert.deepEqual(trimestral.series.received, [1, 1, 1, 0]);
  const anual = domain.buildDemandAnalytics(demandasTrimestre, {
    period: periodAno, now, calculos: [], granularity: 'anual'
  });
  assert.deepEqual(anual.buckets.map(b => b.key), ['2026']);
  assert.deepEqual(anual.series.received, [3]);

  const todo = domain.buildDemandAnalytics([
    { id: 'H1', modalidade: 'individual', status: 'entregue', dataRequisicao: '2025-01-10', concluidaEm: '2025-01-20T12:00:00Z' },
    { id: 'H2', modalidade: 'individual', status: 'pendente', dataRequisicao: '2026-11-01' }
  ], { now, calculos: [] });
  assert.equal(todo.period.preset, 'todo');
  assert.equal(todo.buckets[0].key, '2025-01');
  assert.equal(todo.buckets[todo.buckets.length - 1].key, '2026-11');
  assert.equal(todo.series.received[0], 1);
  assert.equal(todo.series.received[todo.series.received.length - 1], 1);
});

test('backup v6 valida conclusões, itens e snapshots sem aceitar vínculos cruzados', () => {
  const aggregate = domain.normalizeDemandAggregate(baseAggregate());
  const calculosFechados = aggregate.calculos.map(c => ({
    ...c,
    status: 'entregue',
    concluidoPorCalculistaId: c.calculistaExecutorId,
    concluidoEm: '2026-10-19T12:00:00Z'
  }));
  const demanda = { ...aggregate.demanda, status: 'entregue', concluidaEm: '2026-10-20T12:00:00Z' };
  const conclusao = {
    id: 'CONC-1', demandaId: demanda.id, tipoConclusao: 'impugnacao', situacao: 'vigente',
    versao: 1, concluidaEm: '2026-10-20T12:00:00Z', registradoPor: 'admin'
  };
  const item = {
    id: 'IMP-1', demandaId: demanda.id, conclusaoId: 'CONC-1',
    calculoId: calculosFechados[0].id, reclamanteId: aggregate.reclamantes[0].id,
    escopo: 'calculo_individual', descricao: 'Verba', valorDls: 1000, valorOutraParte: 800
  };
  const payload = {
    migracaoV6: true,
    demandas: [{ ...demanda, reclamantes: aggregate.reclamantes, calculos: calculosFechados, responsaveis: aggregate.responsaveis, conclusoes: [conclusao], impugnacaoItens: [item] }],
    reclamantes: aggregate.reclamantes,
    calculos: calculosFechados,
    responsaveis: aggregate.responsaveis,
    conclusoes: [conclusao],
    impugnacaoItens: [item]
  };
  assert.equal(domain.backupLooksLikeV6(payload), true);
  assert.equal(domain.backupLooksLikeV6({ demandas: [] }), false);
  const valid = domain.validateBackupPayload(payload);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));
  const normalizado = domain.normalizeDemandAggregate({
    demanda,
    reclamantes: aggregate.reclamantes,
    calculos: calculosFechados,
    responsaveis: aggregate.responsaveis,
    conclusoes: [conclusao],
    impugnacaoItens: [item]
  });
  assert.equal(normalizado.conclusoes.length, 1, 'importação v6 não pode descartar conclusões');
  assert.equal(normalizado.conclusoes[0].id, 'CONC-1');
  assert.equal(normalizado.impugnacaoItens.length, 1, 'importação v6 não pode descartar itens');
  assert.equal(normalizado.impugnacaoItens[0].calculoId, calculosFechados[0].id);

  const duasVigentes = domain.validateBackupPayload({
    ...payload,
    demandas: [{ ...demanda, conclusoes: [conclusao, { ...conclusao, id: 'CONC-2', versao: 2 }], impugnacaoItens: [item] }],
    conclusoes: [conclusao, { ...conclusao, id: 'CONC-2', versao: 2 }]
  });
  assert.equal(duasVigentes.valid, false);
  assert.ok(duasVigentes.errors.some(e => e.code === 'BACKUP_CONCLUSAO_VIGENTE_DUPLICADA'));

  const itemCruzado = domain.validateBackupPayload({
    ...payload,
    demandas: [{ ...demanda, conclusoes: [conclusao], impugnacaoItens: [{ ...item, calculoId: 'CLC-404' }] }],
    impugnacaoItens: [{ ...item, calculoId: 'CLC-404' }]
  });
  assert.equal(itemCruzado.valid, false);
  assert.ok(itemCruzado.errors.some(e => e.code === 'BACKUP_IMPUGNACAO_CALCULO'));
});

test('alerta crítico resolve o calculista do perfil por vínculo, e-mail, nome ou login', () => {
  const calculistas = [
    { id: 'CALC-1', nome: 'Ana Luiza Ferreira', email: 'analuiza@dls.com.br' },
    { id: 'CALC-2', nome: 'Carlos Mendes', email: 'carlos@dls.com.br' },
    { id: 'CALC-3', nome: 'Ana Paula', email: 'ana.paula@dls.com.br' }
  ];

  assert.equal(domain.resolveCalculistaForProfile({ calculista_id: 'CALC-2', email: 'x@y.z' }, calculistas).id, 'CALC-2');
  assert.equal(domain.resolveCalculistaForProfile({ calculista_id: 'CALC-REMOVIDO', email: 'analuiza@dls.com.br' }, calculistas), null, 'vínculo explícito inválido não pode cair em heurística');
  assert.equal(domain.resolveCalculistaForProfile({ email: 'ANALUIZA@DLS.COM.BR' }, calculistas).id, 'CALC-1');
  assert.equal(domain.resolveCalculistaForProfile({ nome: 'Ana Luiza' }, calculistas).id, 'CALC-1');
  assert.equal(domain.resolveCalculistaForProfile({ login: 'carlos' }, calculistas).id, 'CALC-2');
  assert.equal(domain.resolveCalculistaForProfile({ login: 'CALC-3' }, calculistas).id, 'CALC-3');
  assert.equal(domain.resolveCalculistaForProfile({ nome: 'Ana' }, calculistas), null, 'correspondência ambígua não pode escolher calculista errado');
  assert.equal(domain.resolveCalculistaForProfile({ nome: 'Pessoa Inexistente' }, calculistas), null);
  assert.equal(domain.resolveCalculistaForProfile({}, []), null);
});

test('alerta crítico lista demandas não terminais vencidas do responsável e da equipe ativa', () => {
  const agora = new Date('2026-11-13T12:00:00-03:00');
  const demandas = [
    { id: 'D-1', numero: 'DLS-1', status: 'andamento', prazo: '2026-11-12', responsavelId: 'CALC-1' },
    { id: 'D-2', numero: 'DLS-2', status: 'atrasada', prazo: '2026-12-01', responsavelId: 'CALC-2', responsaveis: [{ calculistaId: 'CALC-1', ativo: true }] },
    { id: 'D-3', numero: 'DLS-3', status: 'pendente', prazo: '2026-11-10', responsavelId: 'CALC-2', responsaveis: [{ calculistaId: 'CALC-1', ativo: true }] },
    { id: 'D-4', numero: 'DLS-4', status: 'entregue', prazo: '2026-11-01', responsavelId: 'CALC-1' },
    { id: 'D-5', numero: 'DLS-5', status: 'pendente', prazo: '2026-11-20', responsavelId: 'CALC-1' },
    { id: 'D-6', numero: 'DLS-6', status: 'cancelada', prazo: '2026-11-01', responsavelId: 'CALC-1' },
    { id: 'D-7', numero: 'DLS-7', status: 'andamento', prazo: '2026-11-12', responsavelId: 'CALC-2', responsaveis: [{ calculistaId: 'CALC-1', ativo: false }] },
    { id: 'D-8', numero: 'DLS-8', status: 'andamento', prazo: '2026-11-12', responsavelId: 'CALC-3' }
  ];

  const atrasadas = domain.overdueDemandsForCalculista(demandas, 'CALC-1', agora);
  assert.deepEqual(atrasadas.map(d => d.id), ['D-3', 'D-1', 'D-2']);
  assert.deepEqual(domain.overdueDemandsForCalculista(demandas, '', agora), []);
  assert.deepEqual(domain.overdueDemandsForCalculista([], 'CALC-1', agora), []);
});

test('alerta crítico lista apenas convocações de reunião pendentes e ainda não encerradas', () => {
  const agora = new Date('2026-11-13T12:00:00-03:00');
  const reunioes = [
    { id: 'R-1', titulo: 'Planejamento', dataHora: '2026-11-14T09:00:00-03:00', duracao: 60, participantIds: ['U-1'] },
    { id: 'R-2', titulo: 'Em andamento', dataHora: '2026-11-13T11:30:00-03:00', duracao: 60, participantIds: ['U-1'] },
    { id: 'R-3', titulo: 'Encerrada', dataHora: '2026-11-13T09:00:00-03:00', duracao: 60, participantIds: ['U-1'] },
    { id: 'R-4', titulo: 'Outro usuário', dataHora: '2026-11-14T10:00:00-03:00', duracao: 60, participantIds: ['U-2'] },
    { id: 'R-5', titulo: 'Já vista', dataHora: '2026-11-14T11:00:00-03:00', duracao: 60, participantIds: ['U-1'] }
  ];
  const vistas = [domain.meetingAlertKey(reunioes[4])];
  const pendentes = domain.pendingMeetingInvites(reunioes, 'U-1', vistas, agora);
  assert.deepEqual(pendentes.map(r => r.id), ['R-2', 'R-1']);
  assert.equal(domain.pendingMeetingInvites(reunioes, '', vistas, agora).length, 0);
  assert.equal(domain.pendingMeetingInvites([], 'U-1', vistas, agora).length, 0);

  const comSet = domain.pendingMeetingInvites(reunioes, 'U-1', new Set(vistas), agora);
  assert.deepEqual(comSet.map(r => r.id), ['R-2', 'R-1']);
});
