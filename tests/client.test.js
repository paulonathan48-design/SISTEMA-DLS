'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('tipos canônicos exibem Cálculo Cível e E-Social sem manter Cálculo Civil', () => {
  assert.match(html, /<option value="Cálculo Cível">Cálculo Cível<\/option>/);
  assert.match(html, /<option value="E-Social">E-Social<\/option>/);
  assert.doesNotMatch(html, /<option value="Cálculo Civil">/);
  assert.match(html, /const tipos = \[\.\.\.domain\.CALC_TYPES\]/);
  assert.match(html, /normalizeCalcType\(selected\)/);
});

test('status inline persiste via RPC, reverte em falha e nunca grava entregue direto', () => {
  assert.match(html, /data-status-anterior="\$\{dlsEsc\(statusAtual\)\}"/);
  assert.match(html, /function alterarStatusInline\(select\)/);
  assert.match(html, /if \(novo === 'entregue'\) \{\s*select\.value = anterior;\s*abrirConclusaoDemanda\(demandaId\);/);
  assert.match(html, /select\.value = anterior;\s*select\.disabled = true;[\s\S]*?DB\.alterarStatusDemanda\(demandaId, novo, motivo\)/);
  assert.match(html, /catch \(err\) \{\s*select\.value = anterior;/);
  assert.match(html, /function _motivoReaberturaStatus\(demandaId, novoStatus\)/);
  assert.match(html, /statusAnterior === 'entregue' && !String\(motivo \|\| ''\)\.trim\(\)/);
  assert.match(html, /Informe o motivo da reabertura da demanda entregue/);
});

test('conclusão usa RPCs auditadas, histórico v6 e não cria total financeiro agregado', () => {
  assert.match(html, /concluirDemanda\(demandaId, tipoConclusao, itens, observacao\)/);
  assert.match(html, /this\.rpc\('dls_concluir_demanda', \{/);
  assert.match(html, /this\.rpc\('dls_alterar_status_demanda', \{/);
  assert.match(html, /this\.rpc\('dls_restaurar_conclusoes_demanda', \{/);
  assert.match(html, /if \(status === 'entregue'\) \{\s*throw new Error\('Use o fluxo de conclusão/);
  assert.match(html, /<option value="impugnacao">/);
  assert.match(html, /<option value="concordancia">/);
  assert.match(html, /<option value="atualizacao">/);
  assert.match(html, /<option value="apresentacao">/);
  assert.match(html, /nenhum total consolidado é gerado/);
  assert.doesNotMatch(html, /valorTotalImpugnacao|totalImpugnacao|somaImpugnacao/);
  assert.match(html, /a\.conclusoes \|\| \[\]/);
  assert.match(html, /a\.impugnacaoItens \|\| \[\]/);
});

test('relatórios, impressão e XLSX incluem conclusão, impugnação e filtros v6', () => {
  for (const id of ['relFiltroExecutor', 'relFiltroCalcStatus', 'relFiltroConclusao', 'relFiltroBusca', 'relDemandasResumo', 'relCalculosResumo', 'relResumoSecoes', 'relConclusoesTable', 'relImpugnacaoTable']) {
    assert.ok(html.includes(`id="${id}"`), `elemento ${id} deve existir`);
  }
  assert.match(html, /addSheetStd\('Conclusoes'/);
  assert.match(html, /addSheetStd\('Impugnacao'/);
  assert.match(html, /Diferenca assinada/);
  assert.match(html, /Diferenca absoluta/);
  assert.match(html, /conclusaoHeader/);
  assert.match(html, /impugnacaoHeader/);
  assert.match(html, /buildDemandAnalytics\(base, \{[\s\S]*?calcExecutorId,[\s\S]*?calcStatus,[\s\S]*?conclusionType,[\s\S]*?search/);
  assert.match(html, /buildDemandAnalytics\(demandasTodas, \{[\s\S]*?calcExecutorId: executorFiltro,[\s\S]*?calcStatus: calcStatusFiltro,[\s\S]*?conclusionType: conclusaoFiltro,[\s\S]*?search: buscaFiltro/);
  assert.match(html, /renderConclusaoDetalhe/);
  assert.match(html, /function _podeVerDiagnosticoV6\(\)/);
  assert.match(html, /if \(!_podeVerDiagnosticoV6\(\)\) return '';/);
  assert.match(html, /Conclusão temporariamente indisponível/);
  assert.match(html, /Histórico de conclusões anteriores/);
});

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
  assert.match(html, /if \(DB\.hasColetivas\(\) && !DB\.relatedDataReady\(\)\) \{[\s\S]*?não foram carregados/);
  assert.match(html, /const demandas = sortDemandasList\(dlsFilterDemandasList\(DB\.getDemandas\(\)\)\);[\s\S]*?const demandasById = \{\};/);
});

test('exportação XLSX reutiliza as abas e as colunas detalhadas do relatório', () => {
  assert.match(html, /addSheetStd\('Reclamantes', 'DLS - Reclamantes por demanda'/);
  assert.match(html, /addSheetStd\('Equipe', 'DLS - Equipe por demanda'/);
  assert.match(html, /addSheetStd\('Calculos', 'DLS - Produção de cálculos/);
  assert.match(html, /DLS_EXPORT_HEADERS\.demandas/);
  assert.match(html, /DLS_EXPORT_HEADERS\.calculos/);
  assert.match(html, /name: 'Reclamantes', title: 'DLS - Reclamantes por demanda'/);
  assert.match(html, /name: 'Equipe', title: 'DLS - Equipe por demanda'/);
  assert.match(html, /dlsExportDate\(d\.prazo\)/);
});

test('exportação XLSX declara o domínio antes do primeiro uso no callback de demandas', () => {
  const start = html.indexOf('function dlsExportDemandaRows(demandas, lookup)');
  assert.ok(start >= 0);
  const end = html.indexOf('\n    function ', start + 10);
  assert.ok(end > start);
  const fn = html.slice(start, end);
  const declaracao = fn.indexOf('const domain = ctx.domain || window.DLSDomain;');
  const primeiroUso = fn.indexOf('domain && ctx.relatedReady');
  assert.ok(declaracao > 0, 'domain precisa ser declarado no início da exportação');
  assert.ok(primeiroUso > declaracao, 'domain não pode ser usado antes da declaração (TDZ)');
  assert.equal(fn.match(/const domain = /g).length, 1);
});

test('exportação resolve nomes uma vez e não recalcula métricas por linha', () => {
  const helperStart = html.indexOf('function dlsExportCalcName(');
  const helperEnd = html.indexOf('\n    function ', helperStart + 10);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = html.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /DB\.getCalculistas\(\)/);
  assert.match(helper, /DB\.get\(DB\.KEY_CALCULISTAS\)/);

  const rowsStart = html.indexOf('function dlsExportDemandaRows(');
  const rowsEnd = html.indexOf('\n    function ', rowsStart + 10);
  assert.ok(rowsStart >= 0 && rowsEnd > rowsStart);
  const rowsFn = html.slice(rowsStart, rowsEnd);
  assert.doesNotMatch(rowsFn, /DB\.getCalculistas\(\)/);
  assert.doesNotMatch(rowsFn, /DB\.getClientes\(\)/);
  assert.match(rowsFn, /const ctx = lookup \|\| dlsExportLookup\(\);/);

  assert.match(html, /dlsExportLookup\(\{ domain, calcs, clientes, relatedReady: DB\.relatedDataReady\(\) \}\)/);
  assert.match(html, /dlsExportCalculoRows\(calculosExport, demandasById, exportLookup\)/);
  assert.match(html, /dlsExportCalculoRows\(rows, ctx\.demandasById, exportLookup\)/);
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

test('novas demandas usam sequência própria com piso atômico, sem depender de main', () => {
  const start = html.indexOf('nextDemandSequence()');
  assert.ok(start >= 0);
  const end = html.indexOf('\n      calculistaToRow', start);
  assert.ok(end > start);
  const fn = html.slice(start, end);
  assert.match(fn, /dls_next_demand_sequence/);
  assert.match(fn, /p_last_used/);
  assert.match(fn, /getAllDemandas\(\)/);
  assert.match(fn, /seq <= ultimo/);
  assert.match(html, /nextId\(tipo = 'main'\)/);
  assert.match(html, /sequenceName = 'calculistas'/);
  assert.match(html, /sequenceName = 'clientes'/);
  assert.match(html, /dls_next_sequence', \{ sequence_name: sequenceName, default_value: lastUsed \}/);
  assert.match(html, /proximaIdentidadeDemanda\(\) \{\s*const seq = this\.nextDemandSequence\(\);/);
  assert.match(html, /const identidade = this\.proximaIdentidadeDemanda\(\);/);
  assert.match(html, /data\.id = 'CALC-' \+ this\.nextId\('calculista'\)/);
  assert.match(html, /data\.id = 'CLI-' \+ this\.nextId\('cliente'\)/);
  assert.match(html, /_maiorIdNumerico\(this\.getAllDemandas\(\), 'DLS', 100\)/);
  const saveStart = html.indexOf('saveDemanda(data) {');
  const saveEnd = html.indexOf('\n      deleteDemanda', saveStart);
  assert.ok(saveStart > 0 && saveEnd > saveStart);
  assert.doesNotMatch(html.slice(saveStart, saveEnd), /this\.nextId\(\)/);
});

test('seed em banco v6 não grava entregue direto', () => {
  assert.match(html, /if \(this\.hasConclusoes\(\)\) \{\s*demandas\.forEach\(d => \{/);
  assert.match(html, /d\.status = 'andamento';\s*d\.concluidaEm = null;/);
});

test('dashboard oferece granularidade e encaminha os cartões e séries ao relatório', () => {
  assert.match(html, /id="dashboardGranularidade"/);
  assert.match(html, /<option value="mensal" selected>Mensal<\/option>/);
  assert.match(html, /<option value="trimestral">Trimestral<\/option>/);
  assert.match(html, /<option value="anual">Anual<\/option>/);
  assert.match(html, /buildDemandAnalytics\(demandas, \{ period, calculos: DB\.getAllCalculos\(\), granularity: granularidade \}\)/);
  assert.match(html, /function abrirRelatorioDashboard\(status, modalidade, secao\)/);
  assert.match(html, /abrirRelatorioDashboard\('', '', 'relReclamantesTable'\)/);
  assert.match(html, /abrirRelatorioDashboard\('', '', 'relCalcTable'\)/);
  assert.match(html, /abrirRelatorioDashboard\('atrasada', '', 'relDemandasResumo'\)/);
  assert.match(html, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
});

test('usuário comum vê demandas pelo vínculo com calculista e não por id de perfil', () => {
  assert.match(html, /resolveCalculistaForProfile\(profile, this\.getCalculistas\(\)\)/);
  assert.match(html, /d\.responsavelId === calculistaId/);
  assert.match(html, /Array\.isArray\(d\.allowedUserIds\) && d\.allowedUserIds\.includes\(userId\)/);
  assert.match(html, /function renderCalculistas\(\) \{\s*\/\/[\s\S]*?if \(!AUTH\.has\('calculistas\.view'\)\) return;/);
  assert.match(html, /getDemandaVisivel\(id\) \{/);
  assert.match(html, /function openDetalhe\(id\) \{\s*const d = DB\.getDemandaVisivel\(id\)/);
  assert.match(html, /function editarDemanda\(id\) \{\s*const d = DB\.getDemandaVisivel\(id\)/);
  assert.match(html, /function renderDetalheColetiva\(demandaId\) \{[\s\S]*?DB\.getDemandaVisivel\(demandaId\)/);
});

test('perfis listados na UI não carregam hash nem salt de senha', () => {
  assert.match(html, /profileSelect\(options = \{\}\) \{/);
  assert.match(html, /options\.includeSecrets === true\s*\? '\*'\s*:\s*'id,login,email,nome,role,permissions,active,created_at,updated_at'/);
  assert.match(html, /select: this\.profileSelect\(options\)/);
  assert.match(html, /select: this\.profileSelect\(\), id:/);
  assert.match(html, /select: '\*', login:/);
  assert.match(html, /getProfiles\(options = \{\}\) \{/);
  assert.match(html, /normalizeProfile\(p, options\)/);
  assert.match(html, /normalizeProfile\(profile, options = \{\}\) \{/);
  assert.match(html, /delete normalized\.password_hash;/);
  assert.match(html, /delete normalized\.password_salt;/);
  assert.match(html, /this\.profile = this\.normalizeProfile\(profile\);/);
  assert.match(html, /this\.getProfiles\(\{ includeSecrets: true \}\)/);
  assert.doesNotMatch(html, /this\.profile = profile;/);
});

test('timestamps do banco preservam o instante e reuniões usam Brasília', () => {
  assert.match(html, /datetimeOut\(value\) \{[\s\S]*?return time\.toISOString\(\);/);
  assert.match(html, /reuniaoFromRow\(row\) \{[\s\S]*?dataHora: dt && !Number\.isNaN\(dt\.getTime\(\)\) \? dt\.toISOString\(\) : ''/);
  assert.match(html, /reuniaoToRow\(item\) \{[\s\S]*?domain\.parseInstant\(item\.dataHora\)/);
  assert.match(html, /if \(data\.dataHora\) \{\s*const domain = window\.DLSDomain;\s*const iso = domain && domain\.fromSaoPauloInput/);
  assert.match(html, /const dtLocal = dlsDateTimeInput\(r\.dataHora\);/);
  assert.match(html, /DLS_XLSX\.download\(wb, 'producao_calculos_' \+ hojeLocal\(\) \+ '\.xlsx'\)/);
  assert.match(html, /const dateStamp = hojeLocal\(\);/);
  assert.match(html, /downloadFile\('backup_dls_' \+ hojeLocal\(\) \+ '\.json'/);
  assert.match(html, /function hojeLocal\(\) \{\s*const domain = window\.DLSDomain;\s*return domain && domain\.todayIso/);
});

test('alerta crítico cobre a tela e só pode ser dispensado pelo X', () => {
  assert.match(html, /id="criticalAlertOverlay"/);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /z-index: 30000/);
  assert.match(html, /\.critical-alert-overlay\.is-open\s*\{\s*display: flex/);
  assert.match(html, /function dlsCheckCriticalAlerts\(\)/);
  assert.match(html, /pendingMeetingInvites\(/);
  assert.match(html, /overdueDemandsForCalculista\(/);
  assert.match(html, /typeof domain\.pendingMeetingInvites !== 'function'/);
  assert.match(html, /DLS_CRITICAL_ALERTS_/);
  assert.match(html, /state\.overdue = \{ signature: pending\.overdueSignature, at: now \}/);
  assert.match(html, /if \(e\.key === 'Escape'\)[\s\S]*?stopPropagation\(\)/);
  assert.match(html, /buildNotifs\(\);\s*dlsCheckCriticalAlerts\(\);/);
  assert.match(html, /renderReunioes\(\);\s*dlsCheckCriticalAlerts\(\);/);
  assert.match(html, /showToast\('Dados atualizados!'\);\s*dlsCheckCriticalAlerts\(\);/);

  const start = html.indexOf('id="criticalAlertOverlay"');
  const end = html.indexOf('<!-- MAIN -->', start);
  assert.ok(start > 0 && end > start);
  const overlay = html.slice(start, end);
  assert.equal((overlay.match(/<button/g) || []).length, 1, 'o overlay deve ter apenas o botão X');
  assert.match(overlay, /onclick="fecharAlertaCritico\(\)"/);
  assert.doesNotMatch(overlay, /onclick="(closeModal|toggleNotif|showPage)/);
});

test('SLA e produtividade usam amostra real, fuso e crédito por executor', () => {
  assert.match(html, /const slaTxt = sla === null \|\| sla === undefined \? 'Sem dados'/);
  assert.match(html, /Sem amostra de conclusões ou atrasos no período/);
  assert.match(html, /analytics\.overdueCount} em atraso em aberto/);
  assert.doesNotMatch(html, /analytics\.overdueOpen} em atraso/);
  assert.match(html, /analytics\.slaSample/);
  assert.match(html, /const tempoMedio = '—';/);
  assert.match(html, /Tempo médio não calculado a partir de dados persistidos/);
  assert.match(html, /\['Fuso horário', 'America\/Sao_Paulo'\]/);
  assert.match(html, /\['Fuso horario', 'America\/Sao_Paulo'\]/);
  assert.match(html, /addSheetStd\('Produtividade', 'DLS - Cálculos concluídos por executor creditado'/);
  assert.match(html, /const creditado = c\.concluidoPorCalculistaId;/);
  assert.match(html, /domain\.dateInPeriod\(dataConclusao, period\)/);
});

test('logotipo oficial DLS está embutido e aplicado nas páginas e relatórios', () => {
  assert.match(html, /const DLS_BRAND_B64 = Object\.freeze\(\{/);
  assert.match(html, /full: 'data:image\/jpeg;base64,' \+ DLS_BRAND_B64\.full/);
  assert.match(html, /mark: 'data:image\/png;base64,' \+ DLS_BRAND_B64\.mark/);
  assert.match(html, /data-dls-logo="mark"/);
  assert.match(html, /data-dls-logo="full"/);
  assert.match(html, /function applyBrandAssets\(root = document\)/);
  assert.match(html, /const icon = document\.querySelector\('link\[rel="icon"\]'\) \|\| document\.createElement\('link'\);/);
  assert.match(html, /icon\.href = DLS_BRAND\.mark;/);
  assert.match(html, /applyBrandAssets\(\);\s*await AUTH\.init\(\);/);
  assert.match(html, /class="login-brand-logo" src="\$\{DLS_BRAND\.full\}"/);
  assert.match(html, /<img src="\$\{DLS_BRAND\.full\}" alt="DLS - Assessoria e Consultoria Pública e Empresarial" style="width:118px/);
  assert.match(html, /id="reportPrintHeader"/);
  assert.match(html, /function imprimirRelatorio\(\)/);
  assert.match(html, /dls-printing-report/);
  assert.match(html, /window\.addEventListener\('afterprint'/);

  const full = html.match(/full: '([^']+)'/);
  const mark = html.match(/mark: '([^']+)'/);
  assert.ok(full && full[1].startsWith('/9j/'), 'logo completo deve ser JPEG embutido');
  assert.ok(mark && mark[1].startsWith('iVBORw0KGgo'), 'marca deve ser PNG embutida');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'dls-logo.jpg')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'dls-logo-mark.png')));
});

test('todas as exportações Excel usam o mesmo padrão, com logotipo e sem CSV', () => {
  assert.match(html, /const DLS_XLSX = \(\(\) => \{/);
  assert.match(html, /async function download\(wb, filename\)/);
  assert.match(html, /ewb\.addImage\(\{ base64: DLS_BRAND_B64\.mark, extension: 'png' \}\)/);
  assert.match(html, /ewb\.worksheets\.forEach\(ws => \{/);
  assert.match(html, /ws\.addImage\(markId, \{ tl: \{ col: 0, row: 0 \}/);
  assert.match(html, /const DLS_EXPORT_HEADERS = Object\.freeze\(/);
  assert.match(html, /function dlsFilterDemandasList\(base\)/);
  assert.match(html, /let demandas = sortDemandasList\(dlsFilterDemandasList\(DB\.getDemandas\(\)\)\);/);
  assert.match(html, /const demandas = sortDemandasList\(dlsFilterDemandasList\(DB\.getDemandas\(\)\)\);/);
  assert.match(html, /DLS_XLSX\.addSheet\(wb, \{ name: 'Resumo', title: 'DLS - Demandas'/);
  assert.match(html, /DLS_XLSX\.addSheet\(wb, \{ name: 'Demandas', title: 'DLS - Demandas'/);
  assert.match(html, /DLS_XLSX\.addSheet\(wb, \{ name: 'Reclamantes', title: 'DLS - Reclamantes por demanda'/);
  assert.match(html, /DLS_XLSX\.addSheet\(wb, \{ name: 'Equipe', title: 'DLS - Equipe por demanda'/);
  assert.match(html, /DLS_XLSX\.addSheet\(wb, \{ name: 'Calculos', title: 'DLS - Produção de cálculos/);
  assert.match(html, /DLS_XLSX\.download\(wb, `demandas_dls_\$\{hojeLocal\(\)\}\.xlsx`\)/);
  assert.match(html, /DLS_XLSX\.download\(wb, 'producao_calculos_' \+ hojeLocal\(\) \+ '\.xlsx'\)/);
  assert.match(html, /DLS_XLSX\.download\(wb, `relatorio_dls_\$\{dateStamp\}\$\{perTag\}\.xlsx`\)/);
  assert.match(html, /<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/exceljs@4\.4\.0\/dist\/exceljs\.min\.js"><\/script>/);
  assert.doesNotMatch(html, /XLSX\.writeFile\(/);
  assert.doesNotMatch(html, /text\/csv/);
  assert.doesNotMatch(html, /Exportar\s+CSV/);
});

test('usuários podem concluir cálculos e entregar demandas com permissões próprias', () => {
  const accessStart = html.indexOf('const ACCESS = {');
  const accessEnd = html.indexOf('const PAGE_ACCESS', accessStart);
  assert.ok(accessStart > 0 && accessEnd > accessStart);
  const accessBlock = html.slice(accessStart, accessEnd);
  const userBlock = accessBlock.slice(accessBlock.indexOf('user: {'));
  assert.match(userBlock, /'demandas\.entregar': true, 'calculos\.concluir': true/);
  assert.match(html, /\['demandas\.entregar', 'Alterar status e entregar demandas'\]/);
  assert.match(html, /\['calculos\.concluir', 'Concluir cálculos'\]/);
  assert.match(html, /const podeEntregar = !window\.AUTH \|\| \(AUTH\.has && AUTH\.has\('demandas\.entregar'\)\);/);
  assert.match(html, /const podeConcluir = podeEntregar && !entregue && d\.status !== 'cancelada';/);

  // O status também é liberado pela permissão de entrega, não apenas por demandas.manage.
  assert.match(html, /const podeEditar = podeGerir \|\| \(podeEntregar && statusAtual !== 'entregue'\);/);
  assert.match(html, /if \(!window\.AUTH \|\| !\(AUTH\.has\('demandas\.entregar'\) \|\| AUTH\.has\('demandas\.manage'\)\)\) \{/);
  assert.match(html, /const podeAlterarStatus = podeGerirStatus \|\| \(podeEntregarStatus && d\.status !== 'entregue'\);/);
  assert.match(html, /if \(!\(AUTH\.has\('demandas\.entregar'\) \|\| AUTH\.has\('demandas\.manage'\)\)\) \{\s*showToast\('Sem permissão para alterar o status desta demanda\.'/);
  assert.match(html, /if \(d\.status === 'entregue' && novoStatus !== 'entregue' && !AUTH\.has\('demandas\.manage'\)\) \{/);

  // O modal de edição também permite salvar somente o status para quem pode entregar.
  assert.match(html, /id="demandaSalvarBtn"/);
  assert.match(html, /function _configurarBotaoSalvarDemanda\(modo, demanda\)/);
  assert.match(html, /visivel = podeGerir \|\| \(AUTH\.has\('demandas\.entregar'\) && demanda && demanda\.status !== 'entregue'\);/);
  assert.match(html, /if \(!podeGerir && !\(editId && AUTH\.has\('demandas\.entregar'\)\)\) \{/);
  assert.match(html, /if \(orig\.status === 'entregue' && novoStatus !== 'entregue' && !podeGerir\) \{/);
  assert.doesNotMatch(html, /\['salvarDemanda', 'demandas\.manage'\]/);

  assert.match(html, /function abrirConclusaoDemanda\(demandaId\) \{\s*if \(!window\.AUTH \|\| !AUTH\.require\('demandas\.entregar'\)\) return;/);
  assert.match(html, /function confirmarConclusaoDemanda\(\) \{\s*if \(!window\.AUTH \|\| !AUTH\.require\('demandas\.entregar'\)\) return;/);
  assert.match(html, /function _abrirCreditoCalculo\(calculoId, modo\) \{\s*if \(modo === 'concluir'\) \{\s*if \(!AUTH\.require\('calculos\.concluir'/);
  assert.match(html, /const podeConcluirCalculo = !window\.AUTH \|\| \(AUTH\.has && AUTH\.has\('calculos\.concluir'\)\);/);
  assert.match(html, /if \(preparados\.pendentes\.length && !AUTH\.has\('calculos\.concluir'\)\)/);
  assert.match(html, /if \(window\.AUTH && !window\.AUTH\.has\('calculos\.concluir'\)\) \{\s*throw new Error\('Você não tem permissão para concluir cálculos\.'\);/);
  assert.match(html, /if \(window\.AUTH && !window\.AUTH\.has\('demandas\.entregar'\)\) \{\s*throw new Error\('Você não tem permissão para entregar demandas\.'\);/);
  assert.doesNotMatch(html, /Somente administradores podem concluir, reabrir ou corrigir o crédito de cálculos/);
});
