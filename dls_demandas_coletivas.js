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

  const CALC_TYPES = Object.freeze([
    'Análise Prévia',
    'Cartão de Ponto',
    'Cálculo Trabalhista',
    'Cálculo Previdenciário',
    'Cálculo Cível',
    'Cálculo Administrativo',
    'Liquidação de Sentença',
    'Atualização Monetária',
    'Cálculo Tributário',
    'Honorários Advocatícios',
    'Correção Monetária',
    'Cálculo de Rescisão',
    'E-Social'
  ]);

  const CONCLUSION_TYPES = Object.freeze(['impugnacao', 'concordancia', 'atualizacao', 'apresentacao']);
  const CONCLUSION_LABELS = Object.freeze({
    impugnacao: 'Impugnação',
    concordancia: 'Concordância',
    atualizacao: 'Atualização',
    apresentacao: 'Apresentação'
  });
  const CONCLUSION_SCOPES = Object.freeze(['calculo_individual', 'coletivo_geral']);
  const MONEY_LIMIT = 9999999999999.99;

  const PERIOD_PRESETS = Object.freeze([
    'mes_atual',
    'trimestre_atual',
    'semestre_atual',
    'ano_atual',
    'ultimos_30',
    'ultimos_90',
    'todo',
    'personalizado'
  ]);

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

  const SAO_PAULO_TIME_ZONE = 'America/Sao_Paulo';

  // Criar um Intl.DateTimeFormat e caro. Em exportacoes grandes esta funcao e
  // chamada milhares de vezes, entao o formatador e criado uma unica vez e
  // reutilizado. formatToParts e seguro para chamadas repetidas.
  let saoPauloFormatter = null;
  let saoPauloFormatterUnavailable = false;

  function getSaoPauloFormatter() {
    if (saoPauloFormatter || saoPauloFormatterUnavailable) return saoPauloFormatter;
    try {
      saoPauloFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: SAO_PAULO_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
    } catch (err) {
      saoPauloFormatterUnavailable = true;
    }
    return saoPauloFormatter;
  }

  function _saoPauloParts(dt) {
    if (!dt || Number.isNaN(dt.getTime())) return null;
    const formatter = getSaoPauloFormatter();
    if (formatter) {
      try {
        const parts = formatter.formatToParts(dt);
        const values = {};
        for (const part of parts) {
          if (part.type !== 'literal') values[part.type] = part.value;
        }
        const year = Number(values.year);
        const month = Number(values.month);
        const day = Number(values.day);
        const hour = Number(values.hour);
        const minute = Number(values.minute);
        const second = Number(values.second);
        if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
        return { year, month, day, hour, minute, second };
      } catch (err) {
        // Cai no fallback abaixo se o formatador falhar para este valor.
      }
    }
    // Ambientes sem Intl: o Brasil nao possui horario de verao desde 2019.
    // O fallback fixo em UTC-3 preserva o dia civil na maior parte dos casos.
    const shifted = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds()
    };
  }

  function saoPauloParts(value) {
    const dt = value instanceof Date ? value : parseInstant(value);
    return _saoPauloParts(dt);
  }

  // Converte uma data/hora de parede em America/Sao_Paulo para o instante UTC
  // correspondente. O duplo cálculo cobre transições de fuso.
  function saoPauloWallTimeToInstant(year, month, day, hour, minute, second) {
    const utcGuess = Date.UTC(
      Number(year), Number(month) - 1, Number(day),
      Number(hour || 0), Number(minute || 0), Number(second || 0)
    );
    if (!Number.isFinite(utcGuess)) return null;
    let instant = new Date(utcGuess);
    for (let i = 0; i < 2; i += 1) {
      const parts = _saoPauloParts(instant);
      if (!parts) break;
      const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      // O deslocamento deve ser medido no instante candidato, não no palpite
      // inicial. Isso mantém a convergência em fusos com horário de verão.
      const offset = asIfUtc - instant.getTime();
      instant = new Date(utcGuess - offset);
    }
    return instant;
  }

  // Timestamps sem fuso vindos do banco são gravados em UTC pelo cliente
  // (datetimeIn) e por now() do PostgreSQL. Já datas/horas digitadas em
  // formulários representam o horário oficial de Brasília.
  function parseInstant(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const raw = String(value).trim();
    if (!raw) return null;
    const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnlyMatch) {
      return saoPauloWallTimeToInstant(dateOnlyMatch[1], dateOnlyMatch[2], dateOnlyMatch[3], 0, 0, 0);
    }
    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (br) {
      return saoPauloWallTimeToInstant(br[3], br[2], br[1], br[4], br[5], br[6]);
    }
    const naive = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (naive) {
      return new Date(Date.UTC(
        Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]),
        Number(naive[4]), Number(naive[5]), Number(naive[6] || 0),
        Number((naive[7] || '0').padEnd(3, '0'))
      ));
    }
    const dt = new Date(raw);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function dateOnly(value) {
    if (!value) return '';
    if (value instanceof Date) {
      const p = _saoPauloParts(value);
      return p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : '';
    }
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const dt = parseInstant(raw);
    const p = _saoPauloParts(dt);
    return p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : '';
  }

  function saoPauloDateOnly(value) {
    return dateOnly(value);
  }

  function todayIso(now) {
    return saoPauloDateOnly(now || new Date());
  }

  function formatDateBR(value, options) {
    if (!value) return '';
    const dt = parseInstant(value);
    if (!dt) return String(value);
    try {
      return dt.toLocaleDateString('pt-BR', { timeZone: SAO_PAULO_TIME_ZONE, ...(options || {}) });
    } catch (err) {
      return dateOnly(value).split('-').reverse().join('/');
    }
  }

  function formatTimeBR(value, options) {
    if (!value) return '';
    const dt = parseInstant(value);
    if (!dt) return '';
    try {
      return dt.toLocaleTimeString('pt-BR', {
        timeZone: SAO_PAULO_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        ...(options || {})
      });
    } catch (err) {
      const p = _saoPauloParts(dt);
      return p ? `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : '';
    }
  }

  function formatDateTimeBR(value) {
    if (!value) return '';
    const dt = parseInstant(value);
    if (!dt) return String(value);
    try {
      return dt.toLocaleString('pt-BR', {
        timeZone: SAO_PAULO_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
    } catch (err) {
      const date = dateOnly(value).split('-').reverse().join('/');
      const time = formatTimeBR(value, { second: '2-digit' });
      return [date, time].filter(Boolean).join(' ');
    }
  }

  function toSaoPauloInput(value) {
    if (!value) return '';
    const p = saoPauloParts(value);
    if (!p) return '';
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  // Converte o valor de um input datetime-local (horário oficial de Brasília)
  // em ISO UTC. Strings já com fuso explícito são respeitadas.
  function fromSaoPauloInput(value) {
    if (!value) return '';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    const raw = String(value).trim();
    if (!raw) return '';
    if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
      const dt = new Date(raw);
      return Number.isNaN(dt.getTime()) ? '' : dt.toISOString();
    }
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (iso) {
      const dt = saoPauloWallTimeToInstant(iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]);
      return dt ? dt.toISOString() : '';
    }
    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (br) {
      const dt = saoPauloWallTimeToInstant(br[3], br[2], br[1], br[4], br[5], br[6]);
      return dt ? dt.toISOString() : '';
    }
    const dt = new Date(raw);
    return Number.isNaN(dt.getTime()) ? '' : dt.toISOString();
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

  function normalizedLookup(value) {
    return text(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[‐‑‒–—_]+/g, '-')
      .replace(/\s*-\s*/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const CALC_TYPE_BY_KEY = (() => {
    const map = Object.create(null);
    CALC_TYPES.forEach(tipo => { map[normalizedLookup(tipo)] = tipo; });
    map[normalizedLookup('Cálculo Civil')] = 'Cálculo Cível';
    map[normalizedLookup('Calculo Civil')] = 'Cálculo Cível';
    map[normalizedLookup('E Social')] = 'E-Social';
    map[normalizedLookup('ESocial')] = 'E-Social';
    map[normalizedLookup('e_social')] = 'E-Social';
    return Object.freeze(map);
  })();

  function normalizeCalcType(value) {
    const raw = text(value);
    if (!raw) return '';
    return CALC_TYPE_BY_KEY[normalizedLookup(raw)] || raw;
  }

  function normalizeConclusionType(value) {
    const key = normalizedLookup(value);
    const aliases = {
      impugnacao: 'impugnacao',
      concordancia: 'concordancia',
      atualizacao: 'atualizacao',
      apresentacao: 'apresentacao'
    };
    return aliases[key] || '';
  }

  function conclusionLabel(value) {
    return CONCLUSION_LABELS[normalizeConclusionType(value)] || text(value) || '—';
  }

  function normalizeConclusionScope(value) {
    const normalized = normalizedLookup(value);
    if (normalized === 'calculo' || normalized === 'calculo-individual' || normalized === 'individual') return 'calculo_individual';
    if (normalized === 'coletivo' || normalized === 'coletivo-geral' || normalized === 'geral') return 'coletivo_geral';
    return 'calculo_individual';
  }

  function parseMoney(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    let raw = text(value).replace(/\s/g, '').replace(/^R\$/i, '');
    if (!raw) return null;
    if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return Math.round(parsed * 100) / 100;
  }

  function moneyIsValid(value) {
    const parsed = parseMoney(value);
    return parsed !== null && Math.abs(parsed) <= MONEY_LIMIT;
  }

  function formatMoney(value) {
    const parsed = parseMoney(value);
    if (parsed === null) return '—';
    return parsed.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function differenceFor(dlsValue, otherValue) {
    const dls = parseMoney(dlsValue);
    const other = parseMoney(otherValue);
    if (dls === null || other === null) return null;
    const signed = Math.round((dls - other) * 100) / 100;
    const absolute = Math.abs(signed);
    const direction = signed > 0 ? 'DLS maior' : signed < 0 ? 'Outra parte maior' : 'Valores iguais';
    return { signed, absolute, direction };
  }

  function differenceText(dlsValue, otherValue) {
    const diff = differenceFor(dlsValue, otherValue);
    if (!diff) return '—';
    if (diff.direction === 'Valores iguais') return 'Valores iguais';
    return `${diff.direction} em ${formatMoney(diff.absolute)}`;
  }

  // Datas puras são dias civis e não devem ser convertidas. Já timestamps
  // (criado_em/concluida_em) representam um instante e precisam ser lidos no
  // fuso de Brasília, tal como os créditos de cálculo.
  function timestampDateOnly(value) {
    return dateOnly(value);
  }

  function receivedDate(demanda) {
    const d = demanda || {};
    return dateOnly(d.dataRequisicao || d.data_requisicao)
      || timestampDateOnly(d.criadoEm || d.criado_em);
  }

  function demandConclusionDate(demanda) {
    const d = demanda || {};
    return timestampDateOnly(d.concluidaEm || d.concluida_em);
  }

  function isoAddDays(iso, days) {
    const stable = dateOnly(iso);
    if (!stable) return '';
    const [y, m, d] = stable.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
    return dt.toISOString().slice(0, 10);
  }

  function ymdDate(iso) {
    const stable = dateOnly(iso);
    if (!stable) return null;
    const [y, m, d] = stable.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function periodRange(preset, reference, customStart, customEnd, now) {
    const chosen = PERIOD_PRESETS.includes(text(preset)) ? text(preset) : 'mes_atual';
    const ref = dateOnly(reference) || todayIso(now);
    const parts = ref.split('-').map(Number);
    const year = parts[0];
    const month = parts[1];
    if (!year || !month) {
      return { preset: 'todo', from: '', to: '', reference: ref, label: 'Todo o período', error: '' };
    }
    let from = '';
    let to = '';
    if (chosen === 'mes_atual') {
      from = `${year}-${String(month).padStart(2, '0')}-01`;
      to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    } else if (chosen === 'trimestre_atual') {
      const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
      from = `${year}-${String(startMonth).padStart(2, '0')}-01`;
      to = new Date(Date.UTC(year, startMonth + 2, 0)).toISOString().slice(0, 10);
    } else if (chosen === 'semestre_atual') {
      const startMonth = month <= 6 ? 1 : 7;
      from = `${year}-${String(startMonth).padStart(2, '0')}-01`;
      to = new Date(Date.UTC(year, startMonth + 5, 0)).toISOString().slice(0, 10);
    } else if (chosen === 'ano_atual') {
      from = `${year}-01-01`;
      to = `${year}-12-31`;
    } else if (chosen === 'ultimos_30') {
      from = isoAddDays(ref, -29);
      to = ref;
    } else if (chosen === 'ultimos_90') {
      from = isoAddDays(ref, -89);
      to = ref;
    } else if (chosen === 'personalizado') {
      from = dateOnly(customStart);
      to = dateOnly(customEnd);
      if (!from || !to) {
        return { preset: chosen, from, to, reference: ref, label: 'Período personalizado incompleto', error: 'Informe a data inicial e a data final do período personalizado.' };
      }
      if (from > to) {
        return { preset: chosen, from, to, reference: ref, label: 'Período inválido', error: 'A data inicial não pode ser posterior à data final.' };
      }
    } else {
      return { preset: 'todo', from: '', to: '', reference: ref, label: 'Todo o período', error: '' };
    }
    const format = (iso) => iso ? iso.split('-').reverse().join('/') : '—';
    return {
      preset: chosen,
      from,
      to,
      reference: ref,
      label: from && to ? `${format(from)} a ${format(to)}` : 'Todo o período',
      error: ''
    };
  }

  function dateInPeriod(value, period) {
    const date = dateOnly(value);
    if (!date) return false;
    const from = dateOnly(period && period.from);
    const to = dateOnly(period && period.to);
    if (!from && !to) return true;
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }

  const MONTH_LABELS = Object.freeze(['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']);
  const BUCKET_GRANULARITIES = Object.freeze(['mensal', 'trimestral', 'anual']);

  function bucketKeyForDate(value, granularity) {
    const date = dateOnly(value);
    if (!date) return '';
    const mode = BUCKET_GRANULARITIES.includes(text(granularity)) ? text(granularity) : 'mensal';
    if (mode === 'anual') return date.slice(0, 4);
    if (mode === 'trimestral') {
      const month = Number(date.slice(5, 7));
      return `${date.slice(0, 4)}-T${Math.floor((month - 1) / 3) + 1}`;
    }
    return date.slice(0, 7);
  }

  function monthBuckets(period, now, granularity) {
    const today = todayIso(now);
    const mode = BUCKET_GRANULARITIES.includes(text(granularity)) ? text(granularity) : 'mensal';
    const maxBuckets = mode === 'anual' ? 12 : (mode === 'trimestral' ? 24 : 36);
    let from = dateOnly(period && period.from);
    let to = dateOnly(period && period.to);
    if (!from && !to) {
      to = today;
      const [ty, tm] = to.split('-').map(Number);
      const anchor = new Date(Date.UTC(ty, tm - 1, 1));
      anchor.setUTCMonth(anchor.getUTCMonth() - 11);
      from = anchor.toISOString().slice(0, 10);
    } else if (!from) {
      const [ty, tm] = to.split('-').map(Number);
      const anchor = new Date(Date.UTC(ty, tm - 1, 1));
      anchor.setUTCMonth(anchor.getUTCMonth() - 11);
      from = anchor.toISOString().slice(0, 10);
    } else if (!to) {
      to = today;
    }
    if (!from || !to) return [];
    const [fy, fm] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    const buckets = [];
    if (mode === 'anual') {
      for (let y = fy; y <= ty; y += 1) {
        buckets.push({ key: String(y), label: String(y) });
      }
    } else if (mode === 'trimestral') {
      let index = fy * 4 + Math.floor((fm - 1) / 3);
      const end = ty * 4 + Math.floor((tm - 1) / 3);
      while (index <= end) {
        const y = Math.floor(index / 4);
        const q = index % 4;
        buckets.push({ key: `${y}-T${q + 1}`, label: `T${q + 1}/${String(y).slice(-2)}` });
        index += 1;
      }
    } else {
      let index = fy * 12 + (fm - 1);
      const end = ty * 12 + (tm - 1);
      while (index <= end) {
        const y = Math.floor(index / 12);
        const m = index % 12;
        buckets.push({
          key: `${y}-${String(m + 1).padStart(2, '0')}`,
          label: `${MONTH_LABELS[m]}/${String(y).slice(-2)}`
        });
        index += 1;
      }
    }
    // Em intervalos longos, priorizar os períodos mais recentes. Os totais
    // continuam representando todo o período; apenas o eixo é reduzido.
    return buckets.length > maxBuckets ? buckets.slice(-maxBuckets) : buckets;
  }

  function buildDemandAnalytics(demandas, options) {
    const opts = options || {};
    const now = opts.now || new Date();
    const today = todayIso(now);
    const period = opts.period || periodRange(
      opts.preset || 'todo',
      opts.reference,
      opts.from,
      opts.to,
      now
    );
    const requestedStatus = text(opts.status).toLowerCase();
    const statusFilter = DEMAND_STATUSES.includes(requestedStatus) ? requestedStatus : '';
    const typeFilter = text(opts.tipo);
    const clientFilter = text(opts.clienteId);
    const responsibleFilter = text(opts.responsavelId);
    const calcStatusFilter = text(opts.calcStatus);
    const calcExecutorFilter = text(opts.calcExecutorId);
    const conclusionFilter = text(opts.conclusionType);
    const searchFilter = text(opts.search).toLowerCase();
    const modalityFilter = opts.modalidade ? normalizeModalidade(opts.modalidade) : '';

    const all = (demandas || []).filter(d => d && d.id);
    const allCalculations = Array.isArray(opts.calculos)
      ? opts.calculos.map(c => ({
        ...c,
        demandaId: text(c && (c.demandaId || c.demanda_id || (c.demanda && c.demanda.id)))
      }))
      : all.flatMap(d => (d.calculos || []).map(c => ({ ...c, demandaId: d.id, demanda: d })));
    const calculationsByDemand = new Map();
    allCalculations.forEach(c => {
      const demandId = text(c && c.demandaId);
      if (!demandId) return;
      if (!calculationsByDemand.has(demandId)) calculationsByDemand.set(demandId, []);
      calculationsByDemand.get(demandId).push(c);
    });
    const demandCalculations = d => calculationsByDemand.get(String(d.id)) || [];
    const selected = all.filter(d => {
      if (statusFilter && normalizeDemandStatus(d.status) !== statusFilter) return false;
      if (typeFilter && normalizeCalcType(d.tipo) !== normalizeCalcType(typeFilter)) return false;
      if (clientFilter && text(d.clienteId) !== clientFilter) return false;
      if (responsibleFilter) {
        const naEquipe = activeTeam(d.responsaveis).some(r => text(r.calculistaId) === responsibleFilter);
        if (text(d.responsavelId) !== responsibleFilter && !naEquipe) return false;
      }
      if (modalityFilter && normalizeModalidade(d.modalidade) !== modalityFilter) return false;
      if (calcStatusFilter && !demandCalculations(d).some(c => c.ativo !== false && normalizeCalcStatus(c.status) === calcStatusFilter)) return false;
      if (calcExecutorFilter && !demandCalculations(d).some(c => c.ativo !== false && calculationCredit(c) === calcExecutorFilter)) return false;
      if (conclusionFilter) {
        const current = (d.conclusoes || []).find(c => c.situacao === 'vigente');
        const statusAtual = normalizeDemandStatus(d.status);
        const tipoAtual = current
          ? normalizeConclusionType(current.tipoConclusao)
          : (statusAtual === 'entregue' ? 'sem_classificacao' : '');
        if (tipoAtual !== conclusionFilter) return false;
      }
      if (searchFilter) {
        const haystack = [
          d.numero, d.processo, d.chamado, d.reclamante, d.obs,
          ...(d.reclamantes || []).map(r => r.nome)
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(searchFilter)) return false;
      }
      return true;
    });

    const received = selected.filter(d => dateInPeriod(receivedDate(d), period));
    const concluded = selected.filter(d => normalizeDemandStatus(d.status) === 'entregue'
      && dateInPeriod(demandConclusionDate(d), period));
    const delivered = selected.filter(d => normalizeDemandStatus(d.status) === 'entregue');
    const legacyDeliveredWithoutDate = delivered.filter(d => !demandConclusionDate(d));
    const receivedWithoutDate = selected.filter(d => !receivedDate(d));
    const open = selected.filter(d => !TERMINAL_DEMAND_STATUSES.includes(normalizeDemandStatus(d.status)));
    const overdueOpen = open.filter(d => d.prazo && dateOnly(d.prazo) < today);
    const statuses = {};
    DEMAND_STATUSES.forEach(s => { statuses[s] = 0; });
    selected.forEach(d => {
      const status = normalizeDemandStatus(d.status);
      statuses[status] = (statuses[status] || 0) + 1;
    });

    const types = {};
    received.forEach(d => {
      const tipo = normalizeCalcType(d.tipo) || 'Não informado';
      types[tipo] = (types[tipo] || 0) + 1;
    });

    const conclusionTypes = {};
    concluded.forEach(d => {
      const current = (d.conclusoes || []).find(c => c.situacao === 'vigente');
      const key = current ? normalizeConclusionType(current.tipoConclusao || current.tipo_conclusao) : 'sem_classificacao';
      const label = current ? conclusionLabel(key) : 'Sem classificação (legado)';
      conclusionTypes[label] = (conclusionTypes[label] || 0) + 1;
    });

    const selectedSet = new Set(selected.map(d => String(d.id)));
    let calculations = allCalculations.filter(c => {
      const demandId = text(c && (c.demandaId || c.demanda_id));
      return !demandId || selectedSet.has(demandId);
    });
    if (calcStatusFilter) calculations = calculations.filter(c => normalizeCalcStatus(c.status) === calcStatusFilter);
    if (calcExecutorFilter) calculations = calculations.filter(c => calculationCredit(c) === calcExecutorFilter);

    const granularity = BUCKET_GRANULARITIES.includes(text(opts.granularity)) ? text(opts.granularity) : 'mensal';
    const bucketDates = [];
    received.forEach(d => { const date = receivedDate(d); if (date) bucketDates.push(date); });
    concluded.forEach(d => { const date = demandConclusionDate(d); if (date) bucketDates.push(date); });
    calculations.filter(c => c && c.ativo !== false).forEach(c => {
      const created = dateOnly(c.createdAt || c.created_at);
      if (created) bucketDates.push(created);
      if (normalizeCalcStatus(c.status) === 'entregue' && calculationCredit(c)) {
        const done = conclusionDate(c);
        if (done) bucketDates.push(done);
      }
    });
    bucketDates.sort();
    let bucketPeriod = period;
    if (!dateOnly(period.from) && !dateOnly(period.to)) {
      bucketPeriod = bucketDates.length
        ? { ...period, from: bucketDates[0], to: bucketDates[bucketDates.length - 1] }
        : { ...period, from: '', to: '' };
    }
    const buckets = bucketPeriod.preset === 'todo' && !bucketPeriod.from && !bucketPeriod.to
      ? []
      : monthBuckets(bucketPeriod, now, granularity);
    const bucketIndex = new Map(buckets.map((b, i) => [b.key, i]));
    const receivedSeries = buckets.map(() => 0);
    const receivedIndividualSeries = buckets.map(() => 0);
    const receivedCollectiveSeries = buckets.map(() => 0);
    const concludedSeries = buckets.map(() => 0);
    const calculationSeries = buckets.map(() => 0);
    const calculationCreatedSeries = buckets.map(() => 0);
    received.forEach(d => {
      const key = bucketKeyForDate(receivedDate(d), granularity);
      const i = bucketIndex.get(key);
      if (i !== undefined) {
        receivedSeries[i] += 1;
        if (normalizeModalidade(d.modalidade) === 'coletiva') receivedCollectiveSeries[i] += 1;
        else receivedIndividualSeries[i] += 1;
      }
    });
    concluded.forEach(d => {
      const key = bucketKeyForDate(demandConclusionDate(d), granularity);
      const i = bucketIndex.get(key);
      if (i !== undefined) concludedSeries[i] += 1;
    });
    const byDemand = {};
    all.forEach(d => { byDemand[d.id] = d; });
    const calcMetrics = calculationMetricsFor(calculations, {
      today,
      from: period.from,
      to: period.to,
      now,
      demandasById: byDemand
    });
    const calcPeriod = calculations.filter(c => {
      if (!c || c.ativo === false) return false;
      if (normalizeCalcStatus(c.status) !== 'entregue') return false;
      const credit = text(c.concluidoPorCalculistaId || c.concluido_por_calculista_id);
      if (!credit) return false;
      const date = conclusionDate(c);
      return !!date && dateInPeriod(date, period);
    });
    calcPeriod.forEach(c => {
      const key = bucketKeyForDate(conclusionDate(c), granularity);
      const i = bucketIndex.get(key);
      if (i !== undefined) calculationSeries[i] += 1;
    });
    const calcCreated = calculations.filter(c => c && c.ativo !== false && dateOnly(c.createdAt || c.created_at));
    const calcCreatedPeriod = calcCreated.filter(c => dateInPeriod(dateOnly(c.createdAt || c.created_at), period));
    const calcCreatedWithoutDate = calculations.filter(c => c && c.ativo !== false && !dateOnly(c.createdAt || c.created_at)).length;
    calcCreatedPeriod.forEach(c => {
      const key = bucketKeyForDate(dateOnly(c.createdAt || c.created_at), granularity);
      const i = bucketIndex.get(key);
      if (i !== undefined) calculationCreatedSeries[i] += 1;
    });
    const calcStatusCounts = {};
    CALC_STATUSES.forEach(s => { calcStatusCounts[s] = 0; });
    calculations.filter(c => c && c.ativo !== false).forEach(c => {
      const status = normalizeCalcStatus(c.status);
      calcStatusCounts[status] = (calcStatusCounts[status] || 0) + 1;
    });
    const calcTypeCounts = {};
    calcCreatedPeriod.forEach(c => {
      const tipo = normalizeCalcType(c.tipo) || 'Não informado';
      calcTypeCounts[tipo] = (calcTypeCounts[tipo] || 0) + 1;
    });
    const calcModalityCounts = { individual: 0, coletiva: 0 };
    calcCreatedPeriod.forEach(c => {
      const demand = byDemand[text(c.demandaId || c.demanda_id)] || {};
      const modalidade = normalizeModalidade(demand.modalidade);
      calcModalityCounts[modalidade] = (calcModalityCounts[modalidade] || 0) + 1;
    });
    const calcExecutorCounts = {};
    calcPeriod.forEach(c => {
      const credit = text(c.concluidoPorCalculistaId || c.concluido_por_calculista_id);
      calcExecutorCounts[credit] = (calcExecutorCounts[credit] || 0) + 1;
    });
    const claimantIds = new Set();
    received.forEach(d => {
      (d.reclamantes || []).forEach(r => {
        if (r && r.id) claimantIds.add(String(r.id));
      });
    });
    const individualReceived = received.filter(d => normalizeModalidade(d.modalidade) === 'individual').length;
    const collectiveReceived = received.filter(d => normalizeModalidade(d.modalidade) === 'coletiva').length;
    const impugnacaoDirecoes = {};
    let impugnacaoItensCount = 0;
    concluded.forEach(d => {
      const current = (d.conclusoes || []).find(c => c.situacao === 'vigente');
      if (!current || normalizeConclusionType(current.tipoConclusao) !== 'impugnacao') return;
      const itens = (d.impugnacaoItens || []).filter(i => i.conclusaoId === current.id);
      impugnacaoItensCount += itens.length;
      itens.forEach(item => {
        const dir = text(item.direcao) || 'Não classificada';
        impugnacaoDirecoes[dir] = (impugnacaoDirecoes[dir] || 0) + 1;
      });
    });

    const concludedOnTime = concluded.filter(d => {
      const due = dateOnly(d.prazo);
      return !due || demandConclusionDate(d) <= due;
    }).length;
    const concludedLate = concluded.length - concludedOnTime;
    const slaSample = concludedOnTime + concludedLate + overdueOpen.length;
    // Sem amostra não existe SLA: devolver null evita apresentar 100% como
    // se fosse uma medição real (RF-12.8).
    const sla = slaSample > 0
      ? Math.round((concludedOnTime / slaSample) * 100)
      : null;

    return {
      period,
      granularity,
      totalSelected: selected.length,
      totalAll: all.length,
      selectedIds: selected.map(d => String(d.id)),
      received,
      receivedCount: received.length,
      receivedWithoutDate: receivedWithoutDate.length,
      individualReceived,
      collectiveReceived,
      claimantsDistinct: claimantIds.size,
      concluded,
      concludedCount: concluded.length,
      deliveredCount: delivered.length,
      legacyDeliveredWithoutDate: legacyDeliveredWithoutDate.length,
      open,
      openCount: open.length,
      overdueOpen,
      overdueCount: overdueOpen.length,
      statusCounts: statuses,
      typeCounts: types,
      conclusionTypeCounts: conclusionTypes,
      impugnacaoItensCount,
      impugnacaoDirecoes,
      sla,
      slaSample,
      concludedOnTime,
      concludedLate,
      calculations: {
        calendarTotal: calculations.length,
        createdPeriod: calcCreatedPeriod.length,
        createdWithoutDate: calcCreatedWithoutDate,
        concludedPeriod: calcMetrics.concludedPeriod,
        concludedToday: calcMetrics.concludedToday,
        concludedMonth: calcMetrics.concludedMonth,
        totalHistory: calcMetrics.totalHistory,
        historyWithoutDate: calcMetrics.historyWithoutDate,
        openAssigned: calcMetrics.assignedOpen,
        overdue: calcMetrics.overdue,
        statusCounts: calcStatusCounts,
        typeCounts: calcTypeCounts,
        modalityCounts: calcModalityCounts,
        executorCounts: calcExecutorCounts
      },
      buckets,
      series: {
        received: receivedSeries,
        receivedIndividual: receivedIndividualSeries,
        receivedCollective: receivedCollectiveSeries,
        concluded: concludedSeries,
        calculations: calculationSeries,
        calculationsCreated: calculationCreatedSeries
      }
    };
  }

  function validateConclusionInput(input) {
    const source = input || {};
    const tipo = normalizeConclusionType(source.tipoConclusao || source.tipo_conclusao);
    const itens = Array.isArray(source.itens) ? source.itens : [];
    const errors = [];
    if (!tipo) {
      pushError(errors, 'CONCLUSAO_TIPO_OBRIGATORIO', 'Selecione a classificação da conclusão.', 'tipoConclusao');
    }
    if (tipo && tipo !== 'impugnacao' && itens.length) {
      pushError(errors, 'CONCLUSAO_IMPUGNACAO_INDEVIDA', 'Comparações financeiras só podem ser registradas em conclusões do tipo Impugnação.', 'itens');
    }
    if (tipo === 'impugnacao' && !itens.length) {
      pushError(errors, 'IMPUGNACAO_SEM_COMPARACAO', 'A conclusão por Impugnação exige pelo menos uma comparação financeira válida.', 'itens');
    }
    const calculations = new Map((source.calculos || []).map(c => [text(c.id), c]));
    const claimants = new Map((source.reclamantes || []).map(r => [text(r.id), r]));
    const normalized = [];
    itens.forEach((item, index) => {
      const row = item || {};
      const escopo = normalizeConclusionScope(row.escopo);
      const calculoId = text(row.calculoId || row.calculo_id) || null;
      let reclamanteId = text(row.reclamanteId || row.reclamante_id) || null;
      const descricao = text(row.descricao);
      if (escopo === 'calculo_individual' && !calculoId) {
        pushError(errors, 'IMPUGNACAO_SEM_CALCULO', 'Cada comparação de cálculo individual exige um cálculo vinculado.', 'itens', String(index));
      }
      if (escopo === 'coletivo_geral' && (calculoId || reclamanteId)) {
        pushError(errors, 'IMPUGNACAO_GERAL_COM_VINCULO', 'A comparação de escopo coletivo geral não pode apontar para um cálculo ou reclamante individual.', 'itens', String(index));
      }
      if (calculoId) {
        const calculo = calculations.get(calculoId);
        if (source.calculos && !calculo) {
          pushError(errors, 'IMPUGNACAO_CALCULO_OUTRA_DEMANDA', 'O cálculo vinculado à comparação não pertence a esta demanda.', 'itens', String(index));
        }
        if (calculo && calculo.reclamanteId) {
          if (reclamanteId && reclamanteId !== text(calculo.reclamanteId)) {
            pushError(errors, 'IMPUGNACAO_RECLAMANTE_INCOMPATIVEL', 'O reclamante da comparação não corresponde ao reclamante do cálculo.', 'itens', String(index));
          }
          reclamanteId = text(calculo.reclamanteId);
        }
        if (calculo && calculo.escopo === 'coletivo' && reclamanteId) {
          pushError(errors, 'IMPUGNACAO_COLETIVA_COM_RECLAMANTE', 'Cálculo coletivo não pode ser vinculado a um reclamante individual na comparação.', 'itens', String(index));
        }
      }
      if (reclamanteId && source.reclamantes && !claimants.has(reclamanteId)) {
        pushError(errors, 'IMPUGNACAO_RECLAMANTE_OUTRA_DEMANDA', 'O reclamante vinculado à comparação não pertence a esta demanda.', 'itens', String(index));
      }
      if (!moneyIsValid(row.valorDls ?? row.valor_dls)) {
        pushError(errors, 'IMPUGNACAO_VALOR_DLS_INVALIDO', 'Informe um valor válido do cálculo da DLS para cada comparação.', 'itens', String(index));
      }
      if (!moneyIsValid(row.valorOutraParte ?? row.valor_outra_parte)) {
        pushError(errors, 'IMPUGNACAO_VALOR_OUTRA_PARTE_INVALIDO', 'Informe um valor válido apresentado pela outra parte para cada comparação.', 'itens', String(index));
      }
      if (!descricao && (!calculoId || itens.filter(x => text(x.calculoId || x.calculo_id) === calculoId).length > 1)) {
        pushError(errors, 'IMPUGNACAO_DESCRICAO_OBRIGATORIA', 'Informe a rubrica/descrição da comparação.', 'itens', String(index));
      }
      const diff = differenceFor(row.valorDls ?? row.valor_dls, row.valorOutraParte ?? row.valor_outra_parte);
      normalized.push({
        id: text(row.id) || null,
        escopo,
        calculoId,
        reclamanteId,
        descricao,
        valorDls: parseMoney(row.valorDls ?? row.valor_dls),
        valorOutraParte: parseMoney(row.valorOutraParte ?? row.valor_outra_parte),
        diferencaAssinada: diff ? diff.signed : null,
        diferencaAbsoluta: diff ? diff.absolute : null,
        direcao: diff ? diff.direction : '',
        observacao: text(row.observacao)
      });
    });
    return {
      valid: errors.length === 0,
      errors,
      normalized: { tipoConclusao: tipo, itens: normalized }
    };
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
    // Timestamps (com ou sem fuso) são lidos em America/Sao_Paulo.
    return dateOnly(raw);
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
      tipo: normalizeCalcType(source.tipo),
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
    demanda.tipo = normalizeCalcType(text(demanda.tipo)) || 'Cálculo';
    demanda.responsavelId = text(demanda.responsavelId || demanda.responsavel_id) || null;
    const rawValorEstimado = demanda.valorEstimado;
    const valorEstimado = rawValorEstimado === null || rawValorEstimado === undefined || rawValorEstimado === ''
      ? null
      : Number(rawValorEstimado);
    demanda.valorEstimado = valorEstimado === null || !Number.isFinite(valorEstimado) ? null : valorEstimado;

    const reclamantes = (source.reclamantes || []).map((item, index) => normalizeClaimant(item, index, demandaId, now));
    const calculos = (source.calculos || []).map((item, index) => normalizeCalculation(item, index, demandaId, now));
    const responsaveis = (source.responsaveis || []).map((item, index) => normalizeTeamMember(item, index, demandaId, now));
    const conclusoes = deepClone(
      source.conclusoes || demanda.conclusoes || []
    );
    const impugnacaoItens = deepClone(
      source.impugnacaoItens || source.itensImpugnacao || demanda.impugnacaoItens || demanda.itensImpugnacao || []
    );

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
      responsaveis,
      conclusoes,
      impugnacaoItens
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

  function backupLooksLikeV6(payload) {
    const data = payload || {};
    if (data.migracaoV6 === true) return true;
    if (['conclusoes', 'impugnacaoItens', 'itensImpugnacao'].some(key => Array.isArray(data[key]) && data[key].length > 0)) return true;
    const demandas = Array.isArray(data.demandas) ? data.demandas : [];
    return demandas.some(demanda => !!(demanda && (
      (Array.isArray(demanda.conclusoes) && demanda.conclusoes.length > 0)
      || (Array.isArray(demanda.impugnacaoItens) && demanda.impugnacaoItens.length > 0)
      || (Array.isArray(demanda.itensImpugnacao) && demanda.itensImpugnacao.length > 0)
    )));
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

    // As listas superiores de conclusões/itens também precisam de dono
    // explícito. Sem isso, uma linha órfã seria descartada na mesclagem e a
    // importação v6 apagaria o histórico existente sem restaurar nada.
    const topRowsFor = (key) => {
      if (Array.isArray(data[key])) return data[key];
      if (key === 'impugnacaoItens' && Array.isArray(data.itensImpugnacao)) {
        return data.itensImpugnacao;
      }
      return [];
    };
    ['conclusoes', 'impugnacaoItens'].forEach(key => {
      const vistos = new Set();
      topRowsFor(key).forEach(row => {
        const id = text(row && row.id);
        const demandId = text(row && (row.demandaId || row.demanda_id));
        if (!id) {
          pushError(errors, 'BACKUP_FILHO_SEM_ID', `Registro de ${key} sem ID no backup.`, key);
        } else if (vistos.has(id)) {
          pushError(errors, 'BACKUP_FILHO_DUPLICADO', `Registro de ${key} com ID duplicado: ${id}.`, key, id);
        } else {
          vistos.add(id);
        }
        if (!demandId || !demandIdsVistos.has(demandId)) {
          pushError(
            errors,
            'BACKUP_REFERENCIA_INVALIDA',
            `Registro de ${key} aponta para demanda inexistente: ${demandId || '(vazio)'}.`,
            key,
            id
          );
        }
      });
    });
    const topFor = (key, demandId) => topRowsFor(key)
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
        responsaveis: mergeRows(demandId, demanda && demanda.responsaveis, topFor('responsaveis', demandId)),
        conclusoes: mergeRows(demandId, demanda && demanda.conclusoes, topFor('conclusoes', demandId)),
        impugnacaoItens: mergeRows(
          demandId,
          (demanda && (demanda.impugnacaoItens || demanda.itensImpugnacao)) || [],
          topFor('impugnacaoItens', demandId)
        )
      };
    });
    const demandIds = new Set(demandas.map(d => text(d && d.id)).filter(Boolean));
    const claimantOwners = new Map();
    const aggregatesById = new Map();

    demandas.forEach(demanda => {
      const aggregate = normalizeDemandAggregate({
        demanda,
        reclamantes: demanda.reclamantes || [],
        calculos: demanda.calculos || [],
        responsaveis: demanda.responsaveis || []
      }, { allowMissingNumber: true });
      (aggregate.reclamantes || []).forEach(rec => claimantOwners.set(rec.id, aggregate.demanda.id));
      aggregatesById.set(aggregate.demanda.id, aggregate);
      const result = validateDemandAggregate({
        demanda,
        reclamantes: demanda.reclamantes || [],
        calculos: demanda.calculos || [],
        responsaveis: demanda.responsaveis || []
      }, { allowMissingNumber: true });
      result.errors.forEach(error => errors.push({ ...error, demandaId: aggregate.demanda.id }));
    });

    // Conclusões e comparações da v6: preservam IDs, snapshots e versões.
    const conclusaoOwner = new Map();
    const conclusoesPorDemanda = new Map();
    demandas.forEach(demanda => {
      const demandId = text(demanda && demanda.id);
      const vistas = new Set();
      const vigentes = [];
      (demanda.conclusoes || []).forEach(conclusao => {
        const id = text(conclusao && conclusao.id);
        if (!id) {
          pushError(errors, 'BACKUP_CONCLUSAO_SEM_ID', 'Conclusão sem ID no backup.', 'conclusoes');
          return;
        }
        if (vistas.has(id)) {
          pushError(errors, 'BACKUP_CONCLUSAO_DUPLICADA', `Conclusão duplicada na demanda ${demandId}: ${id}.`, 'conclusoes', id);
          return;
        }
        vistas.add(id);
        if (conclusaoOwner.has(id) && conclusaoOwner.get(id) !== demandId) {
          pushError(errors, 'BACKUP_CONCLUSAO_CRUZADA', `Conclusão ${id} aparece em mais de uma demanda.`, 'conclusoes', id);
        } else {
          conclusaoOwner.set(id, demandId);
        }
        const tipo = normalizeConclusionType(conclusao.tipoConclusao || conclusao.tipo_conclusao);
        if (!tipo) {
          pushError(errors, 'BACKUP_CONCLUSAO_TIPO', `Conclusão ${id} possui classificação inválida.`, 'conclusoes', id);
        }
        const situacao = normalizedLookup(conclusao.situacao || 'vigente').replace('substituido', 'substituida');
        if (!['vigente', 'substituida', 'reaberta'].includes(situacao)) {
          pushError(errors, 'BACKUP_CONCLUSAO_SITUACAO', `Conclusão ${id} possui situação inválida.`, 'conclusoes', id);
        }
        if (situacao === 'vigente') vigentes.push(id);
        const versao = Number(conclusao.versao);
        if (!Number.isInteger(versao) || versao <= 0) {
          pushError(errors, 'BACKUP_CONCLUSAO_VERSAO', `Conclusão ${id} possui versão inválida.`, 'conclusoes', id);
        }
      });
      if (vigentes.length > 1) {
        pushError(errors, 'BACKUP_CONCLUSAO_VIGENTE_DUPLICADA', `Demanda ${demandId} possui mais de uma conclusão vigente.`, 'conclusoes');
      }
      conclusoesPorDemanda.set(demandId, vistas);
    });

    const itensVistos = new Set();
    demandas.forEach(demanda => {
      const demandId = text(demanda && demanda.id);
      const conclusoes = conclusoesPorDemanda.get(demandId) || new Set();
      const aggregate = aggregatesById.get(demandId);
      const calculos = new Map(((aggregate && aggregate.calculos) || []).map(c => [c.id, c]));
      const reclamantes = new Set(((aggregate && aggregate.reclamantes) || []).map(r => r.id));
      (demanda.impugnacaoItens || []).forEach(item => {
        const id = text(item && item.id);
        if (!id) {
          pushError(errors, 'BACKUP_IMPUGNACAO_SEM_ID', 'Item de impugnação sem ID no backup.', 'impugnacaoItens');
          return;
        }
        if (itensVistos.has(id)) {
          pushError(errors, 'BACKUP_IMPUGNACAO_DUPLICADA', `Item de impugnação duplicado: ${id}.`, 'impugnacaoItens', id);
          return;
        }
        itensVistos.add(id);
        const conclusaoId = text(item.conclusaoId || item.conclusao_id);
        if (!conclusaoId || !conclusoes.has(conclusaoId)) {
          pushError(errors, 'BACKUP_IMPUGNACAO_CONCLUSAO', `Item ${id} referencia conclusão de outra demanda/inexistente.`, 'impugnacaoItens', id);
        }
        const escopo = normalizeConclusionScope(item.escopo);
        const calculoId = text(item.calculoId || item.calculo_id);
        const reclamanteId = text(item.reclamanteId || item.reclamante_id);
        if (escopo === 'calculo_individual') {
          if (!calculoId || !calculos.has(calculoId)) {
            pushError(errors, 'BACKUP_IMPUGNACAO_CALCULO', `Item ${id} referencia cálculo de outra demanda/inexistente.`, 'impugnacaoItens', id);
          } else {
            const calc = calculos.get(calculoId);
            if (calc.reclamanteId && reclamanteId && calc.reclamanteId !== reclamanteId) {
              pushError(errors, 'BACKUP_IMPUGNACAO_RECLAMANTE', `Item ${id} mistura reclamante de outro vínculo.`, 'impugnacaoItens', id);
            }
            if (calc.reclamanteId && !reclamantes.has(calc.reclamanteId)) {
              pushError(errors, 'BACKUP_IMPUGNACAO_RECLAMANTE', `Item ${id} aponta para reclamante ausente.`, 'impugnacaoItens', id);
            }
          }
        } else if (calculoId || reclamanteId) {
          pushError(errors, 'BACKUP_IMPUGNACAO_GERAL', `Item ${id} de escopo geral não pode ter cálculo/reclamante.`, 'impugnacaoItens', id);
        }
        if (!moneyIsValid(item.valorDls ?? item.valor_dls)) {
          pushError(errors, 'BACKUP_IMPUGNACAO_VALOR_DLS', `Item ${id} possui valor DLS inválido.`, 'impugnacaoItens', id);
        }
        if (!moneyIsValid(item.valorOutraParte ?? item.valor_outra_parte)) {
          pushError(errors, 'BACKUP_IMPUGNACAO_VALOR_OUTRA', `Item ${id} possui valor da outra parte inválido.`, 'impugnacaoItens', id);
        }
      });
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

  function normalizePersonKey(value) {
    return text(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Resolve o cadastro de calculista correspondente ao perfil logado.
   * A ligação explícita (`calculista_id`/`calculistaId`) tem prioridade; quando
   * não existe, usa e-mail e, por último, nome/login com correspondência única.
   */
  function resolveCalculistaForProfile(profile, calculistas) {
    const p = profile || {};
    const list = (calculistas || []).filter(Boolean);
    if (!list.length) return null;

    const explicit = text(p.calculista_id || p.calculistaId);
    if (explicit) {
      // Vínculo explícito é autoritativo: se apontar para um cadastro removido,
      // não tenta adivinhar outro calculista por e-mail/nome.
      return list.find(c => text(c.id) === explicit) || null;
    }

    const email = text(p.email).toLowerCase();
    if (email) {
      const found = list.filter(c => text(c.email).toLowerCase() === email);
      if (found.length === 1) return found[0];
    }

    const nameKey = normalizePersonKey(p.nome);
    if (nameKey) {
      const exact = list.filter(c => normalizePersonKey(c.nome) === nameKey);
      if (exact.length === 1) return exact[0];
      const partial = list.filter(c => {
        const key = normalizePersonKey(c.nome);
        if (!key) return false;
        return (key.includes(nameKey) || nameKey.includes(key))
          && Math.min(key.length, nameKey.length) >= 5;
      });
      if (partial.length === 1) return partial[0];
    }

    const login = text(p.login).toLowerCase();
    if (login) {
      const byCalculistaId = list.filter(c => text(c.id).toLowerCase() === login);
      if (byCalculistaId.length === 1) return byCalculistaId[0];
      if (login.includes('@')) {
        const byLoginEmail = list.filter(c => text(c.email).toLowerCase() === login);
        if (byLoginEmail.length === 1) return byLoginEmail[0];
      }
      const loginKey = normalizePersonKey(login);
      const byEmailLocal = list.filter(c => {
        const local = normalizePersonKey(text(c.email).toLowerCase().split('@')[0]);
        return local && local === loginKey;
      });
      if (byEmailLocal.length === 1) return byEmailLocal[0];
    }

    return null;
  }

  function meetingAlertKey(meeting) {
    const r = meeting || {};
    return [text(r.id), text(r.dataHora), text(r.titulo)].join('|');
  }

  /**
   * Convites de reunião ainda não dispensados. Inclui reuniões em andamento
   * (fim >= agora), exclui as encerradas e as já reconhecidas pelo usuário.
   */
  function pendingMeetingInvites(reunioes, userId, seen, now) {
    const uid = text(userId);
    if (!uid) return [];
    const seenSet = seen instanceof Set
      ? seen
      : new Set((Array.isArray(seen) ? seen : Object.keys(seen || {})).map(text));
    const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const refMs = ref.getTime();
    return (reunioes || []).filter(r => {
      if (!r) return false;
      const participants = Array.isArray(r.participantIds) ? r.participantIds.map(text) : [];
      if (!participants.includes(uid)) return false;
      const start = new Date(r.dataHora || '');
      if (Number.isNaN(start.getTime())) return false;
      const duration = Number(r.duracao || 60);
      const minutes = Number.isFinite(duration) && duration > 0 ? duration : 60;
      if (start.getTime() + minutes * 60000 < refMs) return false;
      return !seenSet.has(meetingAlertKey(r));
    }).sort((a, b) => new Date(a.dataHora || 0) - new Date(b.dataHora || 0));
  }

  /**
   * Demandas não terminais atribuídas ao calculista (principal ou equipe ativa)
   * com status atrasado ou prazo já vencido na data civil de São Paulo.
   */
  function overdueDemandsForCalculista(demandas, calculistaId, now) {
    const id = text(calculistaId);
    if (!id) return [];
    const today = todayIso(now);
    return (demandas || []).filter(d => {
      if (!d) return false;
      const status = normalizeDemandStatus(d.status);
      if (TERMINAL_DEMAND_STATUSES.includes(status)) return false;
      const isResponsible = text(d.responsavelId) === id;
      const isTeamMember = teamCalculistaIds(d.responsaveis).includes(id);
      if (!isResponsible && !isTeamMember) return false;
      if (status === 'atrasada') return true;
      const deadline = dateOnly(d.prazo);
      return !!deadline && deadline < today;
    }).sort((a, b) => {
      const da = dateOnly(a.prazo) || '9999-12-31';
      const db = dateOnly(b.prazo) || '9999-12-31';
      return da.localeCompare(db) || text(a.numero).localeCompare(text(b.numero));
    });
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
    CALC_TYPES,
    CONCLUSION_TYPES,
    CONCLUSION_LABELS,
    CONCLUSION_SCOPES,
    MONEY_LIMIT,
    PERIOD_PRESETS,
    CALC_STATUS_LABELS,
    DEMAND_STATUS_LABELS,
    SAO_PAULO_TIME_ZONE,
    text,
    dateOnly,
    timestampDateOnly,
    todayIso,
    parseInstant,
    saoPauloParts,
    formatDateBR,
    formatTimeBR,
    formatDateTimeBR,
    toSaoPauloInput,
    fromSaoPauloInput,
    isoAddDays,
    normalizeModalidade,
    normalizeScope,
    normalizeCalcStatus,
    normalizeDemandStatus,
    normalizeCalcType,
    normalizeConclusionType,
    conclusionLabel,
    normalizeConclusionScope,
    parseMoney,
    moneyIsValid,
    formatMoney,
    differenceFor,
    differenceText,
    receivedDate,
    demandReceivedDate: receivedDate,
    demandConclusionDate,
    periodRange,
    dateInPeriod,
    monthBuckets,
    bucketKeyForDate,
    BUCKET_GRANULARITIES,
    buildDemandAnalytics,
    validateConclusionInput,
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
    backupLooksLikeV6,
    validateBackupPayload,
    summarizeReclamantes,
    searchableText,
    normalizePersonKey,
    resolveCalculistaForProfile,
    meetingAlertKey,
    pendingMeetingInvites,
    overdueDemandsForCalculista,
    buildTeamFromIds,
    demandAggregateFromLegacy,
    statusLabel,
    demandStatusLabel
  });
});
