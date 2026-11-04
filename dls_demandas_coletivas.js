/*!
 * DLS — Regras de domínio para demandas coletivas.
 * Módulo puro, sem dependências, carregado no navegador (window.DLSDomain)
 * e no Node.js (require) para testes.
 */
(function initDlsDomain(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DLSDomain = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildDlsDomain() {
  'use strict';

  const DEMAND_MODALIDADES = Object.freeze(['individual', 'coletiva']);
  const CALC_SCOPES = Object.freeze(['individual', 'coletivo']);
  const CALC_STATUSES = Object.freeze(['pendente', 'andamento', 'revisao', 'aguardando', 'entregue', 'cancelada']);
  const OPEN_CALC_STATUSES = Object.freeze(['pendente', 'andamento', 'revisao', 'aguardando']);
  const DEMAND_STATUSES = Object.freeze(['triagem', 'pendente', 'andamento', 'revisao', 'aguardando', 'entregue', 'atrasada', 'cancelada']);
  const TERMINAL_CALC_STATUS = 'entregue';
  const TERMINAL_DEMAND_STATUSES = Object.freeze(['entregue', 'cancelada']);

  const CALC_STATUS_LABELS = Object.freeze({
    pendente: 'Pendente',
    andamento: 'Em andamento',
    revisao: 'Em revisão',
    aguardando: 'Aguardando',
    entregue: 'Concluído',
    cancelada: 'Cancelado'
  });

  const DEMAND_STATUS_LABELS = Object.freeze({
    triagem: 'Triagem',
    pendente: 'Pendente',
    andamento: 'Em andamento',
    revisao: 'Em revisão',
    aguardando: 'Aguardando cliente',
    entregue: 'Entregue',
    atrasada: 'Atrasada',
    cancelada: 'Cancelada'
  });

  function text(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function dateOnly(value) {
    if (!value) return '';
    const raw = String(value);
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  }

  function saoPauloDateOnly(value) {
    const dt = value instanceof Date ? value : new Date(value);
    if (!dt || Number.isNaN(dt.getTime())) return '';
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(dt);
      const valueOf = type => (parts.find(p => p.type === type) || {}).value || '';
      const y = valueOf('year');
      const m = valueOf('month');
      const d = valueOf('day');
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch (err) {
      // Intl pode não estar disponível em ambientes muito restritos.
    }
    return dt.toISOString().slice(0, 10);
  }

  function todayIso(now) {
    return saoPauloDateOnly(now || new Date());
  }

  function normalizeModalidade(value) {
    const normalized = text(value).toLowerCase();
    return DEMAND_MODALIDADES.includes(normalized) ? normalized : 'individual';
  }

  function normalizeScope(value) {
    const normalized = text(value).toLowerCase();
    return CALC_SCOPES.includes(normalized) ? normalized : 'individual';
  }

  function normalizeCalcStatus(value, fallback) {
    const normalized = text(value).toLowerCase();
    if (normalized === 'atrasada') return 'andamento';
    if (CALC_STATUSES.includes(normalized)) return normalized;
    return fallback || 'pendente';
  }

  function normalizeDemandStatus(value, fallback) {
    const normalized = text(value).toLowerCase();
    return DEMAND_STATUSES.includes(normalized) ? normalized : (fallback || 'triagem');
  }

  function makeId(prefix, now) {
    const stamp = (now instanceof Date ? now.getTime() : Date.now()).toString(36);
    let random;
    const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      random = cryptoObj.randomUUID().replace(/-/g, '').slice(0, 10);
    } else {
      random = Math.random().toString(36).slice(2, 12);
    }
    return `${text(prefix) || 'DLS'}-${stamp}-${random}`.toUpperCase();
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function sortByOrder(list, fallbackKey) {
    return [...(list || [])].sort((a, b) => {
      const oa = Number(a.ordem);
      const ob = Number(b.ordem);
      const na = Number.isFinite(oa) ? oa : 0;
      const nb = Number.isFinite(ob) ? ob : 0;
      if (na !== nb) return na - nb;
      const ka = String(a[fallbackKey || 'id'] || '');
      const kb = String(b[fallbackKey || 'id'] || '');
      return ka.localeCompare(kb, 'pt-BR');
    });
  }

  function activeClaimants(reclamantes) {
    return sortByOrder((reclamantes || []).filter(r => r && r.ativo !== false), 'ordem');
  }

  function activeCalculations(calculos) {
    return sortByOrder((calculos || []).filter(c => c && c.ativo !== false), 'ordem');
  }

  function activeTeam(responsaveis) {
    return sortByOrder((responsaveis || []).filter(r => r && r.ativo !== false), 'id');
  }

  function primaryClaimant(reclamantes) {
    const active = activeClaimants(reclamantes);
    return active.find(r => r.legadoPrincipal) || active[0] || null;
  }

  function primaryResponsible(responsaveis) {
    const active = activeTeam(responsaveis);
    return active.find(r => r.papel === 'principal') || active.find(r => r.principal === true) || null;
  }

  function teamCalculistaIds(responsaveis) {
    return [...new Set(activeTeam(responsaveis).map(r => text(r.calculistaId || r.calculista_id)).filter(Boolean))];
  }

  function effectiveDeadline(calculo, demanda) {
    return dateOnly(calculo && calculo.prazo) || dateOnly(demanda && demanda.prazo);
  }

  function calculationIsOpen(calculo) {
    return calculo && calculo.ativo !== false && OPEN_CALC_STATUSES.includes(normalizeCalcStatus(calculo.status));
  }

  function calculationIsOverdue(calculo, demanda, now) {
    if (!calculationIsOpen(calculo)) return false;
    const deadline = effectiveDeadline(calculo, demanda);
    if (!deadline) return false;
    const today = todayIso(now);
    return !!today && deadline < today;
  }

  function calculationCredit(calculo) {
    if (!calculo || normalizeCalcStatus(calculo.status) !== TERMINAL_CALC_STATUS) return null;
    const credited = text(calculo.concluidoPorCalculistaId || calculo.concluido_por_calculista_id);
    if (!credited) return null;
    if (!dateOnly(calculo.concluidoEm || calculo.concluido_em)) return null;
    return credited;
  }

  function conclusionDate(calculo) {
    const raw = text(calculo && (calculo.concluidoEm || calculo.concluido_em));
    if (!raw) return '';
    // Datas puras (sem hora) representam o dia informado, sem conversão.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return dateOnly(raw);
    // A view SQL de produtividade usa America/Sao_Paulo. Manter o mesmo dia
    // no frontend evita que conclusões noturnas mudem de data no relatório.
    return saoPauloDateOnly(dt) || dateOnly(raw);
  }

  function freezeConclusion(calculo, creditedId, whenIso, options) {
    const opts = options || {};
    const currentCredit = calculationCredit(calculo);
    const credited = text(creditedId);
    if (!credited) throw new Error('Informe o calculista que executou o cálculo.');
    if (currentCredit && !opts.force) {
      if (currentCredit !== credited) {
        throw new Error('Cálculo já concluído por outro calculista. Use a correção administrativa de crédito.');
      }
      return deepClone(calculo);
    }
    const next = deepClone(calculo || {});
    next.status = TERMINAL_CALC_STATUS;
    next.calculistaExecutorId = next.calculistaExecutorId || credited;
    next.concluidoPorCalculistaId = credited;
    next.concluidoEm = whenIso || new Date().toISOString();
    next.updatedAt = next.concluidoEm;
    return next;
  }

  function reopenCalculation(calculo, whenIso, user, reason) {
    if (!calculo) throw new Error('Cálculo não encontrado.');
    if (normalizeCalcStatus(calculo.status) !== TERMINAL_CALC_STATUS) {
      throw new Error('Somente cálculos concluídos podem ser reabertos.');
    }
    const next = deepClone(calculo);
    next.status = 'andamento';
    next.concluidoPorCalculistaId = null;
    next.concluidoEm = null;
    next.updatedAt = whenIso || new Date().toISOString();
    next.reabertoPor = text(user) || 'sistema';
    next.reabertoEm = next.updatedAt;
    next.motivoReabertura = text(reason);
    return next;
  }

  function calculationMetricsFor(calculos, options) {
    const opts = options || {};
    const today = dateOnly(opts.today) || todayIso();
    const from = dateOnly(opts.from);
    const to = dateOnly(opts.to);
    const demandasById = opts.demandasById || {};
    const target = text(opts.calculistaId);
    const statusFilter = text(opts.status);
    const typeFilter = text(opts.tipo);
    const clientFilter = text(opts.clienteId);

    const rows = (calculos || []).filter(c => c && c.ativo !== false);
    let assignedOpen = 0;
    let inProgress = 0;
    let overdue = 0;
    let concludedPeriod = 0;
    let concludedToday = 0;
    let concludedMonth = 0;
    let totalHistory = 0;
    let historyWithoutDate = 0;

    rows.forEach(calculo => {
      const demand = demandasById[text(calculo.demandaId)] || {};
      if (clientFilter && text(demand.clienteId) !== clientFilter) return;
      if (typeFilter && text(calculo.tipo) !== typeFilter) return;
      if (statusFilter && normalizeCalcStatus(calculo.status) !== normalizeCalcStatus(statusFilter)) return;

      const executorId = text(calculo.calculistaExecutorId);

      if (calculationIsOpen(calculo)) {
        // Em cálculo aberto, o vínculo de produção é o executor designado.
        if (target && executorId !== target) return;
        assignedOpen += 1;
        const status = normalizeCalcStatus(calculo.status);
        if (status === 'andamento' || status === 'revisao') inProgress += 1;
        if (calculationIsOverdue(calculo, demand, opts.now)) overdue += 1;
      }

      if (normalizeCalcStatus(calculo.status) === TERMINAL_CALC_STATUS) {
        // Em cálculo concluído, a produção pertence ao crédito congelado,
        // que pode ter sido corrigido para um calculista diferente do executor original.
        // O total histórico inclui crédito legado sem data confiável (RF-21.8);
        // esse registro não entra em hoje/mês/período e é sinalizado à parte.
        const rawCredit = text(calculo.concluidoPorCalculistaId || calculo.concluido_por_calculista_id);
        if (!rawCredit) return;
        if (target && rawCredit !== target) return;
        const date = conclusionDate(calculo);
        totalHistory += 1;
        if (!date) {
          historyWithoutDate += 1;
          return;
        }
        if (from && date < from) return;
        if (to && date > to) return;
        concludedPeriod += 1;
        if (date === today) concludedToday += 1;
        if (today && date.slice(0, 7) === today.slice(0, 7)) concludedMonth += 1;
      }
    });

    return {
      calculistaId: target || null,
      assignedOpen,
      inProgress,
      overdue,
      concludedPeriod,
      concludedToday,
      concludedMonth,
      totalHistory,
      historyWithoutDate
    };
  }

  function groupCalculationMetrics(calculos, options) {
    const opts = options || {};
    const targetIds = opts.calculistaIds || [];
    const ids = [...new Set([...targetIds.map(text), ...(calculos || []).map(c => text(c.calculistaExecutorId)), ...(calculos || []).map(c => text(c.concluidoPorCalculistaId))].filter(Boolean))];
    return ids.map(id => ({
      calculistaId: id,
      ...calculationMetricsFor(calculos, { ...opts, calculistaId: id })
    }));
  }

  function normalizeClaimant(item, index, demandaId, now) {
    const source = item || {};
    return {
      id: text(source.id) || makeId('REC', now),
      demandaId: text(source.demandaId || source.demanda_id) || text(demandaId),
      nome: text(source.nome),
      observacoes: text(source.observacoes !== undefined ? source.observacoes : source.obs),
      ordem: Number.isFinite(Number(source.ordem)) ? Number(source.ordem) : index,
      ativo: source.ativo !== false,
      legadoPrincipal: source.legadoPrincipal === true || source.legado_principal === true,
      createdAt: source.createdAt || source.created_at || null,
      updatedAt: source.updatedAt || source.updated_at || null
    };
  }

  function normalizeCalculation(item, index, demandaId, now) {
    const source = item || {};
    const rawValue = source.valorResultado === null || source.valorResultado === undefined || source.valorResultado === ''
      ? null
      : Number(source.valorResultado);
    return {
      id: text(source.id) || makeId('CLC', now),
      demandaId: text(source.demandaId || source.demanda_id) || text(demandaId),
      reclamanteId: text(source.reclamanteId || source.reclamante_id) || null,
      escopo: normalizeScope(source.escopo),
      tipo: text(source.tipo),
      origemCalculo: text(source.origemCalculo || source.origem_calculo),
      calculistaExecutorId: text(source.calculistaExecutorId || source.calculista_executor_id) || null,
      prazo: dateOnly(source.prazo),
      status: normalizeCalcStatus(source.status),
      valorResultado: rawValue === null || !Number.isFinite(rawValue) ? null : rawValue,
      observacoes: text(source.observacoes),
      ordem: Number.isFinite(Number(source.ordem)) ? Number(source.ordem) : index,
      ativo: source.ativo !== false,
      legadoPrincipal: source.legadoPrincipal === true || source.legado_principal === true,
      concluidoPorCalculistaId: text(source.concluidoPorCalculistaId || source.concluido_por_calculista_id) || null,
      concluidoEm: source.concluidoEm || source.concluido_em || null,
      origemRegistro: text(source.origemRegistro || source.origem_registro) || 'novo',
      legadoSemReclamante: source.legadoSemReclamante === true || source.legado_sem_reclamante === true,
      creditoLegadoPresumido: source.creditoLegadoPresumido === true || source.credito_legado_presumido === true,
      createdAt: source.createdAt || source.created_at || null,
      updatedAt: source.updatedAt || source.updated_at || null
    };
  }

  function normalizeTeamMember(item, index, demandaId, now) {
    const source = item || {};
    const papel = text(source.papel).toLowerCase() === 'principal' ? 'principal' : 'co_responsavel';
    return {
      id: text(source.id) || makeId('EQP', now),
      demandaId: text(source.demandaId || source.demanda_id) || text(demandaId),
      calculistaId: text(source.calculistaId || source.calculista_id),
      papel,
      ativo: source.ativo !== false,
      atribuidoPor: text(source.atribuidoPor || source.atribuido_por),
      atribuidoEm: source.atribuidoEm || source.atribuido_em || null,
      removidoEm: source.removidoEm || source.removido_em || null
    };
  }

  function normalizeDemandAggregate(input, options) {
    const opts = options || {};
    const now = opts.now instanceof Date ? opts.now : new Date();
    const source = input || {};
    const demanda = deepClone(source.demanda || source.demandaPrincipal || {});
    const demandaId = text(demanda.id) || makeId('DLS', now);
    demanda.id = demandaId;
    demanda.modalidade = normalizeModalidade(demanda.modalidade || demanda.modalidadeDemanda);
    demanda.status = normalizeDemandStatus(demanda.status);
    demanda.numero = text(demanda.numero);
    demanda.tipo = text(demanda.tipo) || 'Cálculo';
    demanda.responsavelId = text(demanda.responsavelId || demanda.responsavel_id) || null;
    const rawValorEstimado = demanda.valorEstimado;
    const valorEstimado = rawValorEstimado === null || rawValorEstimado === undefined || rawValorEstimado === ''
      ? null
      : Number(rawValorEstimado);
    demanda.valorEstimado = valorEstimado === null || !Number.isFinite(valorEstimado) ? null : valorEstimado;

    const reclamantes = (source.reclamantes || []).map((item, index) => normalizeClaimant(item, index, demandaId, now));
    const calculos = (source.calculos || []).map((item, index) => normalizeCalculation(item, index, demandaId, now));
    const responsaveis = (source.responsaveis || []).map((item, index) => normalizeTeamMember(item, index, demandaId, now));

    if (!responsaveis.length && demanda.responsavelId) {
      responsaveis.push(normalizeTeamMember({
        calculistaId: demanda.responsavelId,
        papel: 'principal',
        ativo: true
      }, 0, demandaId, now));
    }
    const activeTeamRows = responsaveis.filter(r => r.ativo !== false);
    const principals = activeTeamRows.filter(r => r.papel === 'principal');
    if (principals.length === 1) {
      demanda.responsavelId = principals[0].calculistaId;
    } else if (demanda.responsavelId && !principals.length) {
      const matching = activeTeamRows.find(r => r.calculistaId === demanda.responsavelId);
      if (matching) matching.papel = 'principal';
    }

    const claimantsActive = activeClaimants(reclamantes);
    const calcActive = activeCalculations(calculos);
    const fallbackReclamante = primaryClaimant(claimantsActive);
    if (fallbackReclamante) {
      demanda.reclamante = fallbackReclamante.nome;
    } else if (demanda.reclamante !== undefined) {
      demanda.reclamante = text(demanda.reclamante);
    }

    // O executor explícito do cálculo é preservado. Apenas cálculos sem executor
    // recebem a sugestão do responsável principal, nunca um co-responsável aleatório.
    // O reclamante NÃO é preenchido automaticamente em demanda coletiva: a escolha
    // precisa ser explícita para não creditar o cálculo à pessoa errada.
    calcActive.forEach(calculo => {
      if (!calculo.calculistaExecutorId && demanda.responsavelId) {
        calculo.calculistaExecutorId = demanda.responsavelId;
      }
    });

    return {
      demanda,
      reclamantes,
      calculos,
      responsaveis
    };
  }

  function pushError(errors, code, message, field, rowId) {
    errors.push({ code, message, field: field || '', rowId: rowId || '' });
  }

  function validateDemandAggregate(input, options) {
    const opts = options || {};
    const normalized = normalizeDemandAggregate(input, opts);
    const { demanda, reclamantes, calculos, responsaveis } = normalized;
    const errors = [];
    const activeRecs = activeClaimants(reclamantes);
    const activeCalcs = activeCalculations(calculos);
    const activeTeams = activeTeam(responsaveis);
    const claimantIds = new Set(activeRecs.map(r => r.id));
    const teamIds = new Set(activeTeams.map(r => r.calculistaId).filter(Boolean));

    if (!text(demanda.numero) && !opts.allowMissingNumber) {
      pushError(errors, 'DEMANDA_NUMERO_OBRIGATORIO', 'O número da demanda é obrigatório.', 'numero');
    }
    if (!text(demanda.tipo)) {
      pushError(errors, 'DEMANDA_TIPO_OBRIGATORIO', 'O tipo principal do cálculo é obrigatório.', 'tipo');
    }
    if (!DEMAND_MODALIDADES.includes(demanda.modalidade)) {
      pushError(errors, 'MODALIDADE_INVALIDA', 'Modalidade da demanda inválida.', 'modalidade');
    }

    const seenRecIds = new Set();
    activeRecs.forEach(rec => {
      if (seenRecIds.has(rec.id)) {
        pushError(errors, 'RECLAMANTE_ID_DUPLICADO', `Reclamante com ID repetido: ${rec.id}.`, 'reclamantes', rec.id);
      }
      seenRecIds.add(rec.id);
      if (!text(rec.nome)) {
        pushError(errors, 'RECLAMANTE_NOME_OBRIGATORIO', 'Informe o nome de todos os reclamantes ativos.', 'reclamantes', rec.id);
      }
    });

    if (demanda.modalidade === 'coletiva') {
      if (!activeRecs.length) {
        pushError(errors, 'COLETIVA_SEM_RECLAMANTE', 'Uma demanda coletiva precisa de pelo menos um reclamante ativo.', 'reclamantes');
      }
      if (!activeCalcs.length) {
        pushError(errors, 'COLETIVA_SEM_CALCULO', 'Uma demanda coletiva precisa de pelo menos um cálculo ativo.', 'calculos');
      }
    } else if (activeRecs.length > 1) {
      pushError(errors, 'INDIVIDUAL_COM_VARIOS_RECLAMANTES', 'Uma demanda individual aceita apenas um reclamante ativo. Use a modalidade coletiva ou inative os excedentes.', 'reclamantes');
    }

    const principals = activeTeams.filter(r => r.papel === 'principal');
    if (!activeTeams.length) {
      pushError(errors, 'EQUIPE_SEM_PRINCIPAL', 'Cadastre/selecione um responsável principal para a demanda.', 'responsaveis');
    } else if (principals.length !== 1) {
      pushError(
        errors,
        principals.length > 1 ? 'MAIS_DE_UM_PRINCIPAL' : 'PRINCIPAL_OBRIGATORIO',
        principals.length > 1
          ? 'A demanda deve ter apenas um responsável principal ativo.'
          : 'Escolha um responsável principal para a equipe.',
        'responsaveis'
      );
    }
    if (demanda.responsavelId && teamIds.size && !teamIds.has(demanda.responsavelId)) {
      pushError(errors, 'PRINCIPAL_FORA_DA_EQUIPE', 'O responsável principal precisa fazer parte da equipe ativa.', 'responsavelId');
    }
    const seenTeam = new Set();
    activeTeams.forEach(member => {
      const key = text(member.calculistaId);
      if (!key) {
        pushError(errors, 'EQUIPE_CALCULISTA_OBRIGATORIO', 'Informe o calculista de todos os vínculos ativos da equipe.', 'responsaveis', member.id);
        return;
      }
      if (seenTeam.has(key)) {
        pushError(errors, 'CALCULISTA_DUPLICADO_NA_EQUIPE', 'O mesmo calculista não pode aparecer duas vezes na equipe ativa.', 'responsaveis', member.id);
      }
      seenTeam.add(key);
    });

    const seenCalcIds = new Set();
    activeCalcs.forEach(calculo => {
      if (seenCalcIds.has(calculo.id)) {
        pushError(errors, 'CALCULO_ID_DUPLICADO', `Cálculo com ID repetido: ${calculo.id}.`, 'calculos', calculo.id);
      }
      seenCalcIds.add(calculo.id);
      if (!text(calculo.tipo)) {
        pushError(errors, 'CALCULO_TIPO_OBRIGATORIO', 'Informe o tipo de todos os cálculos ativos.', 'calculos', calculo.id);
      }
      if (!CALC_STATUSES.includes(calculo.status)) {
        pushError(errors, 'CALCULO_STATUS_INVALIDO', `Status de cálculo inválido: ${calculo.status}.`, 'calculos', calculo.id);
      }
      if (calculo.ativo && !calculo.calculistaExecutorId && calculo.origemRegistro !== 'legado') {
        pushError(errors, 'CALCULO_EXECUTOR_OBRIGATORIO', 'Todo cálculo novo precisa de um calculista executor.', 'calculos', calculo.id);
      }
      // Cálculos já concluídos preservam o executor histórico mesmo que ele
      // tenha sido removido da equipe depois. A exigência de vínculo vale para
      // cálculos ainda abertos.
      if (calculo.status !== TERMINAL_CALC_STATUS
          && calculo.calculistaExecutorId
          && teamIds.size
          && !teamIds.has(calculo.calculistaExecutorId)) {
        pushError(
          errors,
          'EXECUTOR_FORA_DA_EQUIPE',
          'O executor do cálculo precisa fazer parte da equipe ativa da demanda. Adicione-o à equipe explicitamente.',
          'calculos',
          calculo.id
        );
      }
      if (calculo.escopo === 'coletivo' && calculo.reclamanteId) {
        pushError(errors, 'CALCULO_COLETIVO_COM_RECLAMANTE', 'Cálculo de escopo coletivo não pode apontar para um reclamante.', 'calculos', calculo.id);
      }
      if (calculo.escopo === 'individual' && demanda.modalidade === 'coletiva' && !calculo.reclamanteId) {
        pushError(errors, 'CALCULO_INDIVIDUAL_SEM_RECLAMANTE', 'Cálculo individual de demanda coletiva exige um reclamante.', 'calculos', calculo.id);
      }
      if (calculo.reclamanteId && !claimantIds.has(calculo.reclamanteId)) {
        pushError(errors, 'RECLAMANTE_DE_OUTRA_DEMANDA', 'O reclamante do cálculo precisa pertencer a esta demanda.', 'calculos', calculo.id);
      }
      if (calculo.status === TERMINAL_CALC_STATUS) {
        if (!calculo.concluidoPorCalculistaId && calculo.origemRegistro !== 'legado') {
          pushError(errors, 'CONCLUSAO_SEM_CREDITO', 'Cálculo concluído exige o calculista creditado.', 'calculos', calculo.id);
        }
        if (!dateOnly(calculo.concluidoEm) && calculo.origemRegistro !== 'legado') {
          pushError(errors, 'CONCLUSAO_SEM_DATA', 'Cálculo concluído exige data de conclusão.', 'calculos', calculo.id);
        }
      } else if (calculo.concluidoPorCalculistaId || calculo.concluidoEm) {
        pushError(errors, 'CREDITO_EM_CALCULO_ABERTO', 'Cálculo não concluído não pode manter crédito ou data de conclusão. Use a ação de reabrir.', 'calculos', calculo.id);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      normalized
    };
  }

  function backupLooksLikeV5(payload) {
    const data = payload || {};
    if (data.migracaoV5 === true) return true;
    const childKeys = ['reclamantes', 'calculos', 'responsaveis'];
    if (childKeys.some(key => Array.isArray(data[key]) && data[key].length > 0)) return true;
    const demandas = Array.isArray(data.demandas) ? data.demandas : [];
    return demandas.some(demanda => {
      if (!demanda) return false;
      if (normalizeModalidade(demanda.modalidade || demanda.modalidade_demanda) === 'coletiva') return true;
      return childKeys.some(key => Array.isArray(demanda[key]) && demanda[key].length > 0);
    });
  }

  function validateBackupPayload(payload) {
    const errors = [];
    const data = payload || {};
    if (!Array.isArray(data.demandas)) {
      pushError(errors, 'BACKUP_DEMANDAS_AUSENTES', 'O backup não contém a lista de demandas.', 'demandas');
    }
    const rawDemandas = Array.isArray(data.demandas) ? data.demandas : [];

    // IDs são a identidade persistida no backup. Não podem ser gerados,
    // duplicados ou reaproveitados entre demandas diferentes.
    const demandIdsVistos = new Set();
    rawDemandas.forEach(demanda => {
      const id = text(demanda && demanda.id);
      if (!id) {
        pushError(errors, 'BACKUP_DEMANDA_SEM_ID', 'Demanda sem ID no backup.', 'demandas');
      } else if (demandIdsVistos.has(id)) {
        pushError(errors, 'BACKUP_DEMANDA_DUPLICADA', `Demanda com ID duplicado no backup: ${id}.`, 'demandas', id);
      } else {
        demandIdsVistos.add(id);
      }
    });

    ['reclamantes', 'calculos', 'responsaveis'].forEach(key => {
      const topVistos = new Set();
      (Array.isArray(data[key]) ? data[key] : []).forEach(row => {
        const id = text(row && row.id);
        if (!id) {
          pushError(errors, 'BACKUP_FILHO_SEM_ID', `Registro de ${key} sem ID no backup.`, key);
        } else if (topVistos.has(id)) {
          pushError(errors, 'BACKUP_FILHO_DUPLICADO', `Registro de ${key} com ID duplicado: ${id}.`, key, id);
        } else {
          topVistos.add(id);
        }
      });

      const donos = new Map();
      rawDemandas.forEach(demanda => {
        const demandId = text(demanda && demanda.id);
        const vistos = new Set();
        (Array.isArray(demanda && demanda[key]) ? demanda[key] : []).forEach(row => {
          const id = text(row && row.id);
          if (!id) {
            pushError(errors, 'BACKUP_FILHO_SEM_ID', `Registro de ${key} sem ID no backup.`, key);
            return;
          }
          if (vistos.has(id)) {
            pushError(errors, 'BACKUP_FILHO_DUPLICADO', `Registro de ${key} com ID duplicado na demanda ${demandId}: ${id}.`, key, id);
            return;
          }
          vistos.add(id);
          const dono = donos.get(id);
          if (dono && dono !== demandId) {
            pushError(errors, 'BACKUP_FILHO_CRUZADO', `Registro de ${key} ${id} aparece em mais de uma demanda.`, key, id);
          } else {
            donos.set(id, demandId);
          }
        });
      });

      (Array.isArray(data[key]) ? data[key] : []).forEach(row => {
        const id = text(row && row.id);
        const demandId = text(row && (row.demandaId || row.demanda_id));
        const dono = donos.get(id);
        if (id && demandId && dono && dono !== demandId) {
          pushError(errors, 'BACKUP_FILHO_CRUZADO', `Registro de ${key} ${id} aponta para outra demanda no backup.`, key, id);
        }
      });
    });

    const topFor = (key, demandId) => (Array.isArray(data[key]) ? data[key] : [])
      .filter(row => text(row && (row.demandaId || row.demanda_id)) === demandId);
    const mergeRows = (demandId, embedded, topRows) => {
      const out = [];
      const seen = new Set();
      const push = (row) => {
        if (!row) return;
        const id = text(row.id);
        if (id && seen.has(id)) return;
        if (id) seen.add(id);
        out.push({ ...row, demandaId: text(row.demandaId || row.demanda_id) || demandId });
      };
      (Array.isArray(embedded) ? embedded : []).forEach(push);
      topRows.forEach(push);
      return out;
    };
    const demandas = rawDemandas.map(demanda => {
      const demandId = text(demanda && demanda.id);
      return {
        ...demanda,
        reclamantes: mergeRows(demandId, demanda && demanda.reclamantes, topFor('reclamantes', demandId)),
        calculos: mergeRows(demandId, demanda && demanda.calculos, topFor('calculos', demandId)),
        responsaveis: mergeRows(demandId, demanda && demanda.responsaveis, topFor('responsaveis', demandId))
      };
    });
    const demandIds = new Set(demandas.map(d => text(d && d.id)).filter(Boolean));
    const claimantOwners = new Map();

    demandas.forEach(demanda => {
      const aggregate = normalizeDemandAggregate({
        demanda,
        reclamantes: demanda.reclamantes || [],
        calculos: demanda.calculos || [],
        responsaveis: demanda.responsaveis || []
      }, { allowMissingNumber: true });
      (aggregate.reclamantes || []).forEach(rec => claimantOwners.set(rec.id, aggregate.demanda.id));
      const result = validateDemandAggregate({
        demanda,
        reclamantes: demanda.reclamantes || [],
        calculos: demanda.calculos || [],
        responsaveis: demanda.responsaveis || []
      }, { allowMissingNumber: true });
      result.errors.forEach(error => errors.push({ ...error, demandaId: aggregate.demanda.id }));
    });

    ['reclamantes', 'calculos', 'responsaveis'].forEach(key => {
      if (!Array.isArray(data[key])) return;
      data[key].forEach(row => {
        const demandId = text(row.demandaId || row.demanda_id);
        if (!demandId || !demandIds.has(demandId)) {
          pushError(errors, 'BACKUP_REFERENCIA_INVALIDA', `Registro de ${key} aponta para demanda inexistente: ${demandId || '(vazio)'}.`, key, text(row.id));
        }
      });
    });

    (data.calculos || []).forEach(calculo => {
      const recId = text(calculo.reclamanteId || calculo.reclamante_id);
      const demandId = text(calculo.demandaId || calculo.demanda_id);
      if (recId && claimantOwners.has(recId) && claimantOwners.get(recId) !== demandId) {
        pushError(errors, 'BACKUP_RECLAMANTE_CRUZADO', `Cálculo ${calculo.id || ''} referencia reclamante de outra demanda.`, 'calculos', text(calculo.id));
      }
    });

    return { valid: errors.length === 0, errors };
  }

  function summarizeReclamantes(demanda) {
    const modalidade = normalizeModalidade(demanda && demanda.modalidade);
    const recs = activeClaimants(demanda && demanda.reclamantes);
    const calcs = activeCalculations(demanda && demanda.calculos);
    if (modalidade === 'coletiva') {
      return {
        modalidade,
        label: `Coletiva · ${recs.length} reclamante${recs.length === 1 ? '' : 's'} · ${calcs.length} cálculo${calcs.length === 1 ? '' : 's'}`,
        short: `${recs.length} reclamante${recs.length === 1 ? '' : 's'}`,
        names: recs.map(r => r.nome).filter(Boolean),
        count: recs.length,
        calculationCount: calcs.length
      };
    }
    const nome = text((demanda && demanda.reclamante) || (recs[0] && recs[0].nome));
    return {
      modalidade,
      label: nome || '—',
      short: nome || '—',
      names: nome ? [nome] : [],
      count: nome ? 1 : 0,
      calculationCount: calcs.length
    };
  }

  function searchableText(demanda) {
    const recs = activeClaimants(demanda && demanda.reclamantes).map(r => r.nome);
    const calcs = activeCalculations(demanda && demanda.calculos).map(c => c.tipo);
    return [
      demanda && demanda.numero,
      demanda && demanda.processo,
      demanda && demanda.chamado,
      demanda && demanda.tipo,
      demanda && demanda.reclamante,
      ...recs,
      ...calcs
    ].map(text).join(' ').toLowerCase();
  }

  function buildTeamFromIds(calculistaIds, principalId, current, now) {
    const ids = [...new Set((calculistaIds || []).map(text).filter(Boolean))];
    const principal = text(principalId) || ids[0] || '';
    if (principal && !ids.includes(principal)) ids.unshift(principal);
    const byCalculista = new Map();
    (current || []).forEach(item => {
      const id = text(item.calculistaId || item.calculista_id);
      if (id) byCalculista.set(id, item);
    });
    return ids.map((id, index) => normalizeTeamMember({
      ...(byCalculista.get(id) || {}),
      id: (byCalculista.get(id) || {}).id || makeId('EQP', now),
      calculistaId: id,
      papel: id === principal ? 'principal' : 'co_responsavel',
      ativo: true,
      atribuidoPor: (byCalculista.get(id) || {}).atribuidoPor || '',
      atribuidoEm: (byCalculista.get(id) || {}).atribuidoEm || (now instanceof Date ? now.toISOString() : new Date().toISOString())
    }, index, '', now));
  }

  function demandAggregateFromLegacy(demanda) {
    const d = deepClone(demanda || {});
    const recs = Array.isArray(d.reclamantes) ? d.reclamantes : [];
    const calcs = Array.isArray(d.calculos) ? d.calculos : [];
    const team = Array.isArray(d.responsaveis) ? d.responsaveis : [];
    if (!recs.length && text(d.reclamante)) {
      recs.push(normalizeClaimant({ nome: d.reclamante, legadoPrincipal: true, ordem: 0 }, 0, d.id, new Date()));
    }
    if (!calcs.length && text(d.tipo)) {
      calcs.push(normalizeCalculation({
        tipo: d.tipo,
        escopo: 'individual',
        reclamanteId: recs[0] ? recs[0].id : null,
        calculistaExecutorId: text(d.responsavelId) || null,
        prazo: d.prazo || '',
        status: normalizeCalcStatus(d.status),
        origemRegistro: 'legado',
        legadoPrincipal: true,
        legadoSemReclamante: !recs.length,
        concluidoPorCalculistaId: d.status === 'entregue' ? (text(d.responsavelId) || null) : null,
        concluidoEm: d.status === 'entregue' ? (d.concluidaEm || null) : null,
        creditoLegadoPresumido: d.status === 'entregue' && !!text(d.responsavelId)
      }, 0, d.id, new Date()));
    }
    if (!team.length && text(d.responsavelId)) {
      team.push(normalizeTeamMember({ calculistaId: d.responsavelId, papel: 'principal', ativo: true }, 0, d.id, new Date()));
    }
    return normalizeDemandAggregate({
      demanda: { ...d, modalidade: d.modalidade || 'individual' },
      reclamantes: recs,
      calculos: calcs,
      responsaveis: team
    });
  }

  function statusLabel(value) {
    return CALC_STATUS_LABELS[normalizeCalcStatus(value)] || text(value) || '—';
  }

  function demandStatusLabel(value) {
    return DEMAND_STATUS_LABELS[text(value).toLowerCase()] || text(value) || '—';
  }

  return Object.freeze({
    DEMAND_MODALIDADES,
    CALC_SCOPES,
    CALC_STATUSES,
    OPEN_CALC_STATUSES,
    DEMAND_STATUSES,
    TERMINAL_CALC_STATUS,
    TERMINAL_DEMAND_STATUSES,
    CALC_STATUS_LABELS,
    DEMAND_STATUS_LABELS,
    text,
    dateOnly,
    todayIso,
    normalizeModalidade,
    normalizeScope,
    normalizeCalcStatus,
    normalizeDemandStatus,
    makeId,
    escapeHtml,
    deepClone,
    sortByOrder,
    activeClaimants,
    activeCalculations,
    activeTeam,
    primaryClaimant,
    primaryResponsible,
    teamCalculistaIds,
    effectiveDeadline,
    calculationIsOpen,
    calculationIsOverdue,
    calculationCredit,
    conclusionDate,
    freezeConclusion,
    reopenCalculation,
    calculationMetricsFor,
    groupCalculationMetrics,
    normalizeClaimant,
    normalizeCalculation,
    normalizeTeamMember,
    normalizeDemandAggregate,
    validateDemandAggregate,
    backupLooksLikeV5,
    validateBackupPayload,
    summarizeReclamantes,
    searchableText,
    buildTeamFromIds,
    demandAggregateFromLegacy,
    statusLabel,
    demandStatusLabel
  });
});
