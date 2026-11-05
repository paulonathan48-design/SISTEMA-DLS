# SISTEMA-DLS

Aplicação web estática de gestão de demandas jurídicas, hospedada no Vercel e
persistida no Supabase via API REST. A interface principal está em `index.html`
(HTML, CSS e JavaScript inline) e usa `window.DLS_SUPABASE` para a conexão.

Este repositório contém a implementação da **migração v5 — demandas coletivas,
múltiplos reclamantes, equipe de responsáveis e produtividade por cálculo**,
conforme a especificação `DLS_Especificacao_Demandas_Coletivas_v2.md`.

## Arquivos principais

| Arquivo | Função |
| --- | --- |
| `index.html` | Aplicação, telas, CRUDs, importação/exportação, relatórios e integração com Supabase. |
| `dls_demandas_coletivas.js` | Regras de domínio compartilhadas: normalização, validação, prazos, crédito congelado, métricas, conversão legada e escaping. |
| `dls_migration_v5_demandas_coletivas.sql` | Migração aditiva/idempotente: colunas, tabelas filhas, constraints, triggers, RPCs, backfill, view produtividade, RLS/grants. |
| `dls_calculistas_metricas.sql` | Cria o trigger oficial `dls_set_concluida_em`; deve estar aplicado para as datas globais de conclusão. |
| `dls_migration_v4_procurador_chamado.sql` | Pré-requisito de produção: colunas `procurador` e `chamado`. |
| `dls_supabase_schema.sql`, `dls_supabase_browser_schema.sql` | Referências do schema base/RLS existente. |
| `dls_supabase.browser.js` | URL, chave anon e schema público usados pelo navegador. |
| `tests/domain.test.js` | Testes de regras de domínio, legado, backup e métricas. |
| `tests/sql.test.js` | Testes estáticos de segurança/idempotência da migração. |
| `tests/client.test.js` | Invariantes estáticas do frontend (data histórica, estado de erro e reset). |
| `IMPLEMENTACAO_DEMANDAS_COLETIVAS.md` | Relatório de implementação, validações, limitações e rollback. |

## Funcionalidades implementadas

- Demanda continua sendo a unidade principal de Kanban, SLA, prazo e relatório;
  os cálculos são registros filhos.
- Múltiplos reclamantes por demanda, com um reclamante legado principal
  preservado para compatibilidade.
- Equipe operacional com **um único responsável principal ativo** e
  co-responsáveis; `allowed_user_ids` continua sendo apenas controle de acesso e
  não se confunde com a equipe.
- Cada cálculo possui tipo, escopo (`individual`/`coletivo`), reclamante quando
  individual, executor, prazo efetivo, status e valor de resultado.
- Conclusão de cálculo por RPC transacional, com executor creditado e data
  congelados. Reabertura e correção de crédito são ações administrativas
  auditadas. Um cálculo concluído conta uma única vez, pelo crédito vigente.
- Alterações posteriores na equipe não reescrevem crédito ou data de cálculos já
  concluídos. Executor de cálculo **em aberto** deve pertencer à equipe ativa.
- Backfill de demandas existentes: reclamante legado, cálculo legado e equipe
  principal são criados apenas quando a demanda ainda não possui filhos.
- Importação/exportação de backup inclui os filhos v5, valida referências
  cruzadas e não apaga demandas ausentes antes de todas as gravações concluírem.
- A carga inicial pagina as tabelas para não interpretar o limite de linhas do
  PostgREST como ausência de reclamantes, cálculos ou equipe.
- O XLSX detalhado contém abas `Demandas`, `Reclamantes`, `Equipe` e
  `Calculos`, com uma linha por relacionamento e IDs preservados.
- Relatórios e exportações mantêm separados:
  - indicadores de **demandas** (regra legada por `dls_demandas`);
  - indicadores de **produção de cálculos** (uma linha por cálculo, crédito e
    `concluido_em` do cálculo, com filtros e detalhe auditável).
- A exclusão de uma demanda usa a RPC transacional
  `dls_excluir_demanda_completa`; a exclusão isolada de reclamante com cálculo é
  bloqueada por `ON DELETE RESTRICT`.
- O reset destrutivo do banco fica desabilitado quando a estrutura v5 é
  detectada. O fluxo suportado de restauração é backup/importação.

## Pré-requisitos

1. Projeto Supabase de homologação ou produção com o schema base do DLS já
   existente, incluindo `dls_demandas`, `dls_calculistas`, `dls_clientes`,
   `dls_user_profiles` e `dls_logs`.
2. Migrações anteriores aplicadas, no mínimo:
   - colunas de `natureza`, `origem_calculo`, `allowed_user_ids` e demais colunas
     já usadas pela aplicação;
   - `dls_migration_v4_procurador_chamado.sql`;
   - `dls_calculistas_metricas.sql` (trigger de `concluida_em`).
3. Node.js 18+ apenas para executar os testes locais. Não há etapa de build.
4. Credenciais de banco com permissão para DDL e criação de funções/políticas.
   Não use a chave anon em scripts de migração: ela não substitui uma conexão
   administrativa do Supabase.

## Ordem de implantação

> A migração v5 é transacional (`begin`/`commit`) e idempotente, mas deve ser
> executada primeiro em homologação. Não a execute em produção sem backup,
> janela de manutenção e autorização expressa.

1. **Backup completo** do banco pelo painel do Supabase (schema + dados). Guarde
   o snapshot fora do projeto.
2. Confirme em homologação que o schema base e as migrações anteriores estão
   presentes. Verifique em especial:
   ```sql
   select column_name
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'dls_demandas'
      and column_name in ('natureza', 'origem_calculo', 'allowed_user_ids', 'procurador', 'chamado', 'concluida_em');
   ```
3. Aplique `dls_calculistas_metricas.sql` se o trigger `dls_set_concluida_em`
   ainda não existir. A migração v5 garante a coluna `concluida_em`, mas não
   substitui esse trigger.
4. Execute `dls_migration_v5_demandas_coletivas.sql` inteiro em homologação.
   Se as novas RPCs retornarem erro de função não encontrada/schema cache,
   recarregue o schema da API no painel do Supabase antes de testar.
5. Valide com as consultas da seção seguinte e compare os totais com o banco
   anterior.
6. Publique `index.html`, `dls_demandas_coletivas.js` e os demais arquivos
   estáticos. Faça um hard refresh/limpeza de cache nos navegadores.
7. Execute os testes manuais de fumaça em homologação: criar demanda coletiva,
   editar equipe, concluir/reabrir cálculo, gerar relatório, exportar e importar
   backup.
8. Somente depois, repita a migração em produção com backup validado.

## Validação pós-migração

O relatório oficial da migração:

```sql
select public.dls_relatorio_migracao_v5();
```

Consultas de conferência recomendadas:

```sql
-- Demandas e filhos criados pelo backfill.
select modalidade_demanda, count(*) from public.dls_demandas group by 1;

select count(*) as reclamantes_principais
  from public.dls_demanda_reclamantes
 where legado_principal and ativo;

select count(*) as calculos_legados
  from public.dls_demanda_calculos
 where legado_principal;

-- Créditos históricos por calculista. Na linha de base de 03/11/2026 a soma
-- deve ser 718 (ver IMPLEMENTACAO_DEMANDAS_COLETIVAS.md, seção 7).
select concluido_por_calculista_id, count(*) as creditos
  from public.dls_demanda_calculos
 where status = 'entregue' and concluido_em is not null
 group by 1
 order by creditos desc;

-- Não deve haver demanda com mais de um principal ativo.
select demanda_id, count(*)
  from public.dls_demanda_responsaveis
 where ativo and papel = 'principal'
 group by demanda_id
having count(*) > 1;

-- Não deve haver demanda com cálculo ativo e sem principal.
select d.id, d.numero
  from public.dls_demandas d
 where exists (
   select 1 from public.dls_demanda_calculos c
    where c.demanda_id = d.id and c.ativo
 )
   and not exists (
   select 1 from public.dls_demanda_responsaveis r
    where r.demanda_id = d.id and r.ativo and r.papel = 'principal'
 );

-- Conferência da view de produtividade.
select *
  from public.vw_dls_calculos_produtividade
 order by demanda_id, calculo_id
 limit 100;
```

No relatório, valores de `excecoes_legado` são esperados quando o registro
antigo não tinha data confiável de conclusão, executor ou crédito individual.
Esses registros **não** entram em totais de período; quando possuem crédito
legado presumido, são sinalizados por `credito_legado_presumido`.

## Backfill e premissas do legado

- Demandas antigas com `reclamante` preenchido recebem um reclamante principal.
- Demandas antigas com `responsavel_id` válido recebem um membro principal na
  equipe e um cálculo legado com executor igual ao responsável.
- Em demandas já entregues, o crédito legado é preenchido a partir de
  `responsavel_id` e usa `dls_demandas.concluida_em` quando disponível. Essa é
  uma **premissa explícita de migração**, sinalizada por
  `credito_legado_presumido`; ela não altera a regra para novos cálculos.
- Se a data global de conclusão estiver ausente, o cálculo aparece no total
  histórico, mas não em métricas por dia/mês/período.
- O backfill não inventa múltiplos créditos nem duplica cálculos; ele só roda
  para demandas ainda sem filhos.

## Testes

Execute a partir da raiz:

```bash
node --check dls_demandas_coletivas.js
node --test tests/domain.test.js tests/sql.test.js tests/client.test.js
```

A validação do JavaScript inline pode ser feita com o extrator/ESLint usado no
ambiente de desenvolvimento; o `index.html` não possui bundler.

Além dos testes estáticos, esta implementação foi exercitada em um PostgreSQL
embarcado temporário (PGlite). O cenário sintético cobre aplicação da migração
duas vezes, backfill, gravação do agregado, conclusão idempotente, bloqueio de
executor fora da equipe em cálculo aberto, preservação de crédito após troca de
equipe e exclusão transacional. Um segundo cenário carregou, somente para
leitura, os 796 registros reais de produção e confirmou 749 reclamantes, 796
cálculos, 718 créditos (distribuição por calculista idêntica à linha de base),
47 cálculos sem reclamante e zero principal duplicado; a migração foi reaplicada
sem alterar contagens. Esses testes não substituem a validação em Supabase real
(RLS, PostgREST, concorrência).

Também foi executado um E2E local temporário, com PGlite e uma fachada REST, que
serviu o app real e autenticou um admin de teste. Ele cobriu criação de demanda
coletiva, conclusão/correção/reabertura de crédito, preservação do crédito após
troca de equipe, entrega em duas fases, relatórios, CSV, XLSX, backup/restauração
e exclusão transacional. Esse teste encontrou e corrigiu um `ReferenceError` de
TDZ na exportação XLSX; a regressão está coberta por `tests/client.test.js`. O
harness não é versionado e não substitui o E2E em staging com Supabase real.

## Segurança e limitações conhecidas

- **A autenticação atual é client-side.** O DLS usa a chave anon pública do
  Supabase e identifica o usuário em `dls_user_profiles`; não há Supabase Auth
  nem JWT por usuário. Por isso, as políticas RLS novas mantêm o modelo existente
  (`anon`/`authenticated` com acesso total) e a segregação por perfil é aplicada
  apenas pela camada `AUTH`/`DB` no navegador.
- Consequência: as regras de negócio do agregado são garantidas pelas RPCs, mas
  a restrição de administrador para criar demanda coletiva,
  concluir/reabrir/corrigir crédito e excluir demanda é aplicada **somente na
  interface**. Um usuário que possua a anon key pode chamar REST/RPC diretamente.
  O requisito T33 da especificação só será plenamente atendido com uma
  reconstrução de autenticação (Supabase Auth + RLS baseada em identidade).
- As RPCs são `SECURITY INVOKER`; os grants para `anon`/`authenticated` são
  intencionais para manter o funcionamento atual. Não trate a anon key como
  segredo.
- A migração é aditiva, mas ainda assim deve ser executada em cópia de
  homologação primeiro. Não há rollback automático de dados.
- A view e o frontend usam o fuso `America/Sao_Paulo` para agrupar a data de
  conclusão dos cálculos.
- Não foi adicionada uma feature flag de runtime. O desligamento operacional de
  novas demandas coletivas é feito revertendo o frontend; o schema v5 permanece
  aditivo e os dados já gravados são preservados.

## Reset e backup

`resetarDB()` recusa a operação quando a estrutura v5 é detectada, para não
apagar cálculos, créditos e histórico. O caminho suportado é:

1. exportar backup completo pela interface ou pelo banco;
2. restaurar/importar o backup validado;
3. somente em ambiente descartável, recriar o banco manualmente com autorização.

A exclusão de uma demanda inteira usa a RPC transacional e remove, na ordem,
cálculos, reclamantes, equipe e demanda. A exclusão isolada de reclamante com
cálculo é protegida por FK `ON DELETE RESTRICT`.

## Rollback

- **Falha durante a migração:** como todo o script está em uma única transação,
  não deve haver aplicação parcial. Corrija o erro e reexecute.
- **Rollback apenas do frontend:** restaure a versão anterior de `index.html`.
  A versão antiga ignora as novas colunas e tabelas; os dados v5 permanecem no
  banco para uma nova tentativa.
- **Rollback completo do banco:** restaure o snapshot anterior à migração. Não
  remova tabelas ou colunas manualmente em produção sem backup e autorização,
  pois cálculos, créditos e histórico podem ser perdidos.
- **Incidente pós-implantação:** bloqueie novas escritas na aplicação, exporte o
  estado atual para análise, restaure o snapshot e reaplique a migração corrigida
  em homologação antes de nova promoção.

## Documentação de implementação

Consulte `IMPLEMENTACAO_DEMANDAS_COLETIVAS.md` para o relatório detalhado de
arquivos, modelo de dados, regras, testes executados, limitações e checklist de
rollout.
