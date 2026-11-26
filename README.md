# SISTEMA-DLS

Aplicação web estática de gestão de demandas jurídicas, hospedada no Vercel e
persistida no Supabase via API REST. A interface principal está em `index.html`
(HTML, CSS e JavaScript inline) e usa `window.DLS_SUPABASE` para a conexão.

Este repositório contém a implementação da **migração v5 — demandas coletivas,
múltiplos reclamantes, equipe de responsáveis e produtividade por cálculo**, e
da **v6 — conclusão classificada e impugnação**, conforme as especificações
`DLS_Especificacao_Demandas_Coletivas_v2.md` e
`DLS_Especificacao_Atualizacoes_Cirurgicas_v3.md`. Inclui também o complemento de
**alerta crítico operacional** para convocações de reunião e demandas atrasadas,
sem migração de banco.

> **Estado da v6 (25/11/2026):** v5 reaplicada, reconciliação do legado e v6
> aplicadas no Supabase de produção em uma única transação. O frontend v5/v6
> está publicado em `https://sistema-dls.vercel.app` e a produção já registra
> conclusões e itens de impugnação v6. A contagem de fechamento do smoke test é
> **1.415 demandas, 1.346 reclamantes, 1.415 cálculos, 1.422 vínculos de equipe
> e 14 perfis reais**. Uma demanda (`DLS-2026-1698`) foi excluída por um
> administrador durante a janela; a diferença de uma demanda em relação ao
> backup pré-migração é essa exclusão, não perda da migração.

## Status de produção (25/11/2026)

- **Migração:** v5 idempotente + reconciliação + v6 executadas no SQL Editor do
  Supabase em uma transação. O schema cache foi recarregado; as tabelas v6 e as
  RPCs existem e as duas tabelas novas têm RLS habilitado com uma política cada.
- **Frontend:** deploy de `57430ab` na Vercel; o domínio
  `https://sistema-dls.vercel.app` serve a versão v5/v6. O commit inclui a
  reutilização do formatador `Intl` que reduziu o relatório completo de ~11–14 s
  para ~4,2 s.
- **Linha de base no momento da migração:** 1.416 demandas, 1.347 reclamantes,
  1.416 cálculos e 1.423 vínculos; zero demanda sem filhos, zero cálculo aberto
  em demanda entregue, zero `bulk_pendentes`, zero cálculo entregue sem crédito
  e zero demanda com mais de um principal ativo.
- **Reconciliação:** 103 demandas entregues com cálculo legado aberto foram
  corrigidas (98 no caminho em massa + 5 direcionadas); 9 demandas receberam
  tratamento específico e 5 delas também têm o marcador em massa. 498 linhas de
  demanda e 495 de cálculo foram normalizadas para `Cálculo Cível`.
- **Uso real da v6:** após o deploy, usuários reais já criaram 32 conclusões
  (incluindo impugnações) e 18 itens de impugnação. O fluxo de conclusão e o
  histórico versionado estão operando em produção.
- **Smoke de exportação:** com 1.415 demandas, `Exportar Excel` (demandas) gerou
  391.963 bytes em ~2,5 s; `Exportar cálculos` gerou 153.000 bytes em ~0,8 s; o
  relatório completo gerou 533.116 bytes em ~4,2 s, com 13 abas, logo DLS em
  todas as abas e sem erros de console.
- **Limpeza:** os perfis temporários `smoke.admin` e `smoke.user` foram
  removidos; restaram os 14 perfis reais.
- **Backup e script:** snapshot data-only via REST antes da migração, com cópia
  durável e hashes em
  `C:\Users\paulo\Downloads\DLS-backups\prod-backup-2026-11-25T11-21-19-373Z`;
  o script combinado aplicado está na mesma pasta
  (`prod-v5-backfill-reconcile-v6.applied.sql`). O snapshot tem 1.416 demandas,
  3.352 logs, 811 reclamantes, 869 cálculos, 876 vínculos e 14 perfis. Não foi
  criado um `pg_dump` completo nesta janela; o schema v5/v6 é aditivo e o script
  aplicado é transacional.
- **Detalhamento:** a sequência completa, a reconciliação e os resultados do
  smoke estão na seção 18 de `IMPLEMENTACAO_DEMANDAS_COLETIVAS.md`.

### Histórico do rollout v5 (04/11/2026)

- Migração v5 aplicada no Supabase de produção, schema cache do PostgREST
  recarregado e v5 reaplicada após o deploy para cobrir a janela de transição.
- Frontend novo publicado na Vercel em `https://sistema-dls.vercel.app`, deploy
  do commit `e8750f1`.
- Linha de base após a migração: **871 demandas, 812 reclamantes, 871 cálculos,
  871 vínculos de equipe e 752 créditos concluídos**; 12 calculistas, 30 clientes
  e 1.949 logs. Ainda não havia demanda coletiva cadastrada nesse instante.
- `dls_relatorio_migracao_v5()`: `excecoes_legado: []`, nenhum principal
  duplicado ou ausente; `main = 1102`, maior ID `DLS-1102`, próximo ID `DLS-1103`.
- Backup pós-migração validado por `validateBackupPayload`: 4.111.209 bytes,
  SHA-256 `324740f21ce5c28fc6df481a783c18a29ba1dfbdbe1ee383e6e566a482bef587`,
  em `C:\Users\paulo\Downloads\DLS-backups\`.
- Snapshot pré-migração preservado no próprio banco no schema
  `dls_backup_v5_20261104` (871 demandas), além do backup anterior de 843
  demandas.

## Arquivos principais

| Arquivo | Função |
| --- | --- |
| `index.html` | Aplicação, telas, CRUDs, importação/exportação, relatórios e integração com Supabase. |
| `assets/dls-logo.jpg`, `assets/dls-logo-mark.png` | Logotipo oficial DLS em versão completa e marca compacta; também embutidos como data URI em `index.html`. |
| `dls_demandas_coletivas.js` | Regras de domínio compartilhadas: normalização, validação, prazos, crédito congelado, métricas, conversão legada e escaping. |
| `dls_migration_v5_demandas_coletivas.sql` | Migração aditiva/idempotente: colunas, tabelas filhas, constraints, triggers, RPCs, backfill, view produtividade, RLS/grants. |
| `dls_migration_v6_conclusao_impugnacao.sql` | Migração aditiva/idempotente v6: conclusões versionadas, snapshots imutáveis, itens de impugnação, RPCs de conclusão/status/restauração, normalização de tipos e proteção contra escrita direta. |
| `dls_calculistas_metricas.sql` | Cria o trigger oficial `dls_set_concluida_em`; deve estar aplicado para as datas globais de conclusão. |
| `dls_migration_v4_procurador_chamado.sql` | Pré-requisito de produção: colunas `procurador` e `chamado`. |
| `dls_supabase_schema.sql`, `dls_supabase_browser_schema.sql` | Referências do schema base/RLS existente. |
| `dls_supabase.browser.js` | URL, chave anon e schema público usados pelo navegador. |
| `tests/domain.test.js` | Testes de regras de domínio, legado, backup e métricas. |
| `tests/sql.test.js` | Testes estáticos de segurança/idempotência da migração. |
| `tests/client.test.js` | Invariantes estáticas do frontend (data histórica, perfis/segredos, visibilidade, estado de erro, reset e exportações). |
| `tests/v6.test.js` | Invariantes estáticas da migração v6 (tipos, snapshots, RPCs, RLS e proteção contra escrita direta). |
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
  congelados. Concluir cálculos e alterar o status/entregar demandas usam as
  permissões `calculos.concluir` e `demandas.entregar`, concedidas por padrão ao
  papel `user` e revogáveis por usuário em Configurações > Usuários. Reabrir
  demanda já entregue, reabrir cálculo e corrigir crédito continuam exigindo
  permissão de gestão/administração. Um cálculo concluído conta uma única vez,
  pelo crédito vigente.
- Alterações posteriores na equipe não reescrevem crédito ou data de cálculos já
  concluídos. Executor de cálculo **em aberto** deve pertencer à equipe ativa.
- Backfill de demandas existentes: reclamante legado, cálculo legado e equipe
  principal são criados apenas quando a demanda ainda não possui filhos.
- Importação/exportação de backup inclui os filhos v5, valida referências
  cruzadas e não apaga demandas ausentes antes de todas as gravações concluírem.
- A carga inicial pagina as tabelas para não interpretar o limite de linhas do
  PostgREST como ausência de reclamantes, cálculos ou equipe.
- A numeração de demandas, clientes e calculistas usa sequências separadas com
  piso no maior ID já existente. A v5 adiciona `dls_next_demand_sequence` e
  fortalece `dls_next_sequence`; assim uma sequência legada defasada (por exemplo,
  `main = 100` com IDs `DLS-1023`) não gera IDs antigos ou colidentes.
- O XLSX detalhado contém abas `Demandas`, `Reclamantes`, `Equipe` e
  `Calculos`, com uma linha por relacionamento e IDs preservados.
- A identidade visual DLS é aplicada na sidebar, no cabeçalho global, no login,
  na configuração inicial, na aba Relatórios, no favicon e nos cabeçalhos de impressão. O
  logotipo completo e a marca compacta ficam em `assets/` e também embutidos
  como data URI para não depender de rewrite de arquivo estático no Vercel.
- **Todos** os arquivos Excel exportáveis seguem o mesmo padrão da aba
  Relatórios: título, “Gerado em”, “Período”, fuso `America/Sao_Paulo`,
  cabeçalho azul, zebrado, autofiltro, larguras e logotipo DLS no topo de cada
  aba. `Exportar Excel` (demandas), `Exportar cálculos` (produção) e
  `Exportar Excel` (relatório) geram `.xlsx`; não há mais exportação CSV de
  demandas ou cálculos. A exportação de demandas respeita os filtros ativos da
  aba (status, cliente, calculista, reclamante, prazo e busca).
- As exportações resolvem nomes de calculistas e clientes uma única vez por
  arquivo; não recalculam métricas de calculistas por linha. O formatador de
  fuso `America/Sao_Paulo` também é criado uma única vez e reutilizado. No smoke
  de produção com **1.415 demandas, 1.346 reclamantes, 1.415 cálculos e 1.422
  vínculos**, o relatório completo levou ~4,2 s (antes da otimização, ~11–14 s),
  as demandas ~2,5 s e a produção de cálculos ~0,8 s, sem erros de console e
  mantendo o logo em todas as abas.
- Relatórios e exportações mantêm separados:
  - indicadores de **demandas** (regra legada por `dls_demandas`);
  - indicadores de **produção de cálculos** (uma linha por cálculo, crédito e
    `concluido_em` do cálculo, com filtros e detalhe auditável).
- A exclusão de uma demanda usa a RPC transacional
  `dls_excluir_demanda_completa`; a exclusão isolada de reclamante com cálculo é
  bloqueada por `ON DELETE RESTRICT`.
- O reset destrutivo do banco fica desabilitado quando a estrutura v5 é
  detectada. O fluxo suportado de restauração é backup/importação.

### v6 — conclusão classificada e impugnação

- A entrega de uma demanda (`entregue`) não é mais gravada diretamente: a
  interface restaura o status anterior e abre a classificação auditada.
- Modos de conclusão: **Impugnação**, **Concordância**, **Atualização** e
  **Apresentação**. A conclusão é versionada; uma única versão fica vigente por
  demanda e as anteriores permanecem no histórico imutável.
- Reabertura de demanda entregue exige justificativa; a conclusão vigente passa
  para `reaberta` e a data global de conclusão é limpa.
- A impugnação grava valores da DLS e da outra parte por item, com diferença
  assinada e absoluta geradas pelo banco. **Nunca há total financeiro agregado**
  de impugnação em tela, relatório ou exportação.
- Relatórios, impressão e XLSX incluem conclusão, versão, itens de impugnação e
  avisos de legado. A produtividade usa uma linha por cálculo entregue e pelo
  executor efetivamente creditado no período, no fuso `America/Sao_Paulo`.
- Indicadores e gráficos usam a demanda como unidade e eventos de cálculo
  separados; não há junção que duplique demandas coletivas. O dashboard aceita
  granularidade mensal, trimestral e anual.
- `Cálculo Civil` é normalizado para `Cálculo Cível` no banco e na interface;
  `E-Social` é um tipo canônico adicional. Tipos livres existentes são
  preservados.
- Backups v6 restauram conclusões/itens e datas históricas exatas; backups v5
  importados em banco v6 preservam conclusões existentes e restauram apenas
  status/data. A importação só remove demandas ausentes depois de todas as
  gravações concluírem.

### Complemento — alerta crítico de convocação e atraso

- Reuniões: um alerta consolidado em tela cheia é exibido quando o perfil logado
  foi incluído como participante de uma reunião futura ou em andamento e ainda
  não dispensou aquela convocação. A chave de deduplicação é
  `id | dataHora | título`, portanto uma nova reunião ou uma alteração de
  data/título volta a alertar.
- Demandas atrasadas: o perfil logado é associado ao cadastro de calculista por
  vínculo explícito `calculista_id`/`calculistaId`, e-mail, nome normalizado ou
  login, sempre exigindo correspondência única. Entram demandas não entregues e
  não canceladas, com status `atrasada` ou prazo anterior à data operacional em
  `America/Sao_Paulo`, nas quais o calculista é responsável direto ou membro
  ativo da equipe.
- O alerta cobre a aplicação (`z-index: 30000`, fundo escurecido, faixa de
  emergência e ícone pulsante). **Ele não fecha por clique no fundo, `Escape` ou
  timeout; somente pelo botão X.** Ao fechar, a dispensa é gravada por usuário em
  `localStorage`. Demandas atrasadas voltam a alertar quando o conjunto muda ou
  em novo dia operacional; convocações já dispensadas não se repetem.
- A verificação roda no login, na atualização manual, no auto-refresh de 90
  segundos e após salvar uma reunião. Não há push em tempo real: um convidado já
  logado recebe o alerta na próxima sincronização.
- Não há migração, tabela ou RPC nova. O estado de "já visto" é local ao
  navegador; múltiplos dispositivos não compartilham a dispensa. Push
  multi-dispositivo exigiria uma tabela de notificações e realtime no Supabase,
  fora desta entrega.

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
5. O navegador precisa carregar `xlsx-js-style` e `exceljs@4.4.0` pelo CDN
   jsDelivr. Se o ExcelJS não carregar, as exportações continuam gerando
   `.xlsx`, mas sem a imagem do logo; o `xlsx-js-style` é obrigatório para o
   Excel em si. O logo do sistema não depende de CDN porque está embutido no
   `index.html`.

## Ordem de implantação

> O rollout v5 foi concluído em 04/11/2026 e a v5 foi reaplicada junto com a v6
> em 25/11/2026. As instruções abaixo servem para uma nova instalação ou para
> reaplicação; a v5 é transacional (`begin`/`commit`) e idempotente. Não a
> execute em outro ambiente sem backup, janela de manutenção e autorização
> expressa.

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
   Se as novas RPCs (`dls_next_demand_sequence`, `dls_salvar_demanda_coletiva`,
   `dls_concluir_calculo`, etc.) retornarem erro de função não encontrada/schema
   cache, recarregue o schema da API no painel do Supabase antes de testar.
5. Valide com as consultas da seção seguinte, inclusive as sequências, e compare
   os totais com o banco anterior.
6. Publique `index.html`, `dls_demandas_coletivas.js` e os demais arquivos
   estáticos. Faça um hard refresh/limpeza de cache nos navegadores.
7. Execute os testes manuais de fumaça em homologação: criar demanda coletiva e
   conferir que o ID é o maior existente + 1, editar equipe, concluir/reabrir
   cálculo, gerar relatório, exportar e importar backup.
8. Somente depois, repita a migração em produção com backup validado.

## Implantação da v6 (homologação e reaplicação em produção)

A v6 é **aditiva** e deve ser executada depois da v5 já validada. Ela foi
aplicada em produção em 25/11/2026; as etapas abaixo servem para homologação,
auditoria ou reaplicação idempotente:

1. Faça backup completo e valide o JSON com `validateBackupPayload`.
2. Aplique `dls_migration_v6_conclusao_impugnacao.sql` inteiro em banco local
   ou de homologação. O script é transacional e idempotente.
3. Confirme que as RPCs existem e que as tabelas estão protegidas:
   ```sql
   select proname
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and proname in ('dls_concluir_demanda', 'dls_alterar_status_demanda',
                      'dls_restaurar_conclusoes_demanda');
   ```
4. Abra o app local, confirme a mensagem `Migração v6 de conclusão/impugnação
   detectada` e importe um backup v5 validado. Verifique demandas entregues,
   conclusões e itens de impugnação.
5. Execute os testes locais e o ensaio PGlite/PostgreSQL local antes de qualquer
   promoção. A v6 já foi aplicada em produção em 25/11/2026; uma reaplicação
   exige backup, janela e autorização explícita.
6. Valide o alerta crítico com um perfil associável a um calculista que tenha
   reunião futura e demanda atrasada: confirme que `Escape`, clique no fundo e
   timeout não fecham o overlay e que somente o X o dispensa. O estado de dispensa
   fica no navegador e não é sincronizado entre dispositivos.

### Reaplicar/verificar a v6 em produção (já aplicada em 25/11/2026)

A v6 já está aplicada e em uso na produção. O script é transacional e
idempotente; uma reaplicação serve para auditoria ou recuperação. A chave `anon`
usada pelo frontend **não executa DDL**; a migração precisa ser rodada por uma
conexão administrativa:

1. Faça e valide um backup completo.
2. Abra o SQL Editor do Supabase de produção.
3. Cole e execute **todo** o conteúdo de
   `dls_migration_v6_conclusao_impugnacao.sql`. O script é transacional,
   idempotente e termina com `notify pgrst, 'reload schema'`.
4. Confirme as tabelas e as RPCs:
   ```sql
   select to_regclass('public.dls_demanda_conclusoes') as conclusoes,
          to_regclass('public.dls_demanda_impugnacao_itens') as itens;

   select proname
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and proname in ('dls_concluir_demanda', 'dls_alterar_status_demanda',
                      'dls_restaurar_conclusoes_demanda');
   ```
5. Faça hard refresh no app e confirme no console
   `Migração v6 de conclusão/impugnação detectada`.
6. Valide com um perfil administrador e um perfil comum: o administrador vê o
   diagnóstico técnico se algo falhar; o usuário comum não vê SQL/RLS.
7. Se o PostgREST continuar retornando `PGRST205`, execute
   `notify pgrst, 'reload schema';` novamente e aguarde alguns segundos.

Em ambientes onde a v6 ainda não foi aplicada, o aviso técnico fica restrito a
administradores; usuários comuns não recebem a instrução de SQL na tela.

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

-- Créditos históricos por calculista. Na linha de base de 04/11/2026 a soma
-- é 752 (ver IMPLEMENTACAO_DEMANDAS_COLETIVAS.md, seção 7).
select concluido_por_calculista_id, count(*) as creditos
  from public.dls_demanda_calculos
 where status = 'entregue' and concluido_em is not null
 group by 1
 order by creditos desc;

-- Sequências: main pode permanecer defasada para os IDs históricos. As
-- sequências de demandas, clientes e calculistas recebem o maior ID como piso;
-- antes do primeiro uso, as linhas novas ainda podem não existir.
select name, current_value
  from public.dls_sequences
 where name in ('main', 'demandas', 'clientes', 'calculistas')
 order by name;

select max((regexp_replace(id, '[^0-9]', '', 'g'))::int) as maior_id_demanda
  from public.dls_demandas;
-- O primeiro cadastro novo deve receber DLS-(maior_id_demanda + 1). Com a
-- linha de base de 04/11/2026, o próximo ID é DLS-1103.

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
node --test tests/domain.test.js tests/sql.test.js tests/v6.test.js tests/client.test.js
```

Se o PowerShell bloquear scripts `.ps1`, execute cada arquivo diretamente:
`node tests/domain.test.js`, `node tests/sql.test.js`, `node tests/v6.test.js` e
`node tests/client.test.js`.

As suítes estáticas somam **78 testes**: 28 de domínio, 17 de SQL, 10 da v6 e 23
de cliente. O JavaScript inline também foi validado sem erro de sintaxe.

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
sem alterar contagens. Esses testes PGlite não substituem a validação em Supabase
real (RLS, concorrência e volume).

O harness v6 local executou **29/29 verificações** no PGlite: aplicação dupla da
migração, normalização de tipos, conclusão versionada, impugnação com diferenças
calculadas no banco, snapshots imutáveis, reabertura, restauração v5/v6,
bloqueio de escrita direta, upsert de demanda já entregue e exclusão transacional
sem resíduos.

Também foi executado um E2E local temporário, com PGlite e uma fachada REST, que
serviu o app real e autenticou um admin de teste. Ele cobriu criação de demanda
coletiva, conclusão/correção/reabertura de crédito, preservação do crédito após
troca de equipe, entrega em duas fases, relatórios, CSV, XLSX, backup/restauração
e exclusão transacional. Esse teste encontrou e corrigiu um `ReferenceError` de
TDZ na exportação XLSX; a regressão está coberta por `tests/client.test.js`.

Em 18/11/2026 o harness local autenticado confirmou login com o logo completo,
marca na sidebar e no cabeçalho, impressão da aba Relatórios com cabeçalho
oficial e as três exportações Excel. Os arquivos reais gerados tiveram o
logotipo em **todas as abas** (relatório: 13; demandas: 5; produção: 2),
título com fonte 16, merges e autofiltro preservados, sem mensagens de erro no
console. O conjunto local desse smoke test tinha 12 demandas e não substitui o
E2E completo de 871 demandas.

No E2E v6 de 13/11/2026 o backup completo foi importado e reimportado sobre as
871 demandas já existentes: **871 demandas, 753 entregues, 812 reclamantes, 871
cálculos/equipe, 2 versões de conclusão e 1 item**, zero data ausente, **0
divergências** contra o backup e **0 falhas** capturadas nas duas cargas
completas. O backup exportado passou em `validateBackupPayload`; XLSX, CSV,
impressão e relatórios foram conferidos no conjunto completo. Uma primeira
tentativa em 11/11 registrou duas falhas transitórias por demanda, sem qualquer
divergência de dados; a repetição controlada em 13/11 não as reproduziu.

Em seguida, o mesmo app foi exercitado contra **PostgreSQL 17.6 real + PostgREST
16.5** local, com os 796 registros lidos somente para leitura da API de produção.
A migração v5 foi aplicada duas vezes sobre esses dados, o app carregou
796/749/796/796 e o relatório retornou 718 créditos e zero exceções. Nesse
ambiente real foram validados criação coletiva, conclusão/reabertura, crédito
preservado após remoção da equipe, bloqueio de executor fora da equipe, XLSX com
10 abas, backup/exportação e exclusão transacional. O schema local que
reproduzia a carga de produção tinha a sequência `main` defasada em 100,
embora os IDs importados chegassem a `DLS-1023`, `CALC-708` e `CLI-1005`; a
numeração foi corrigida para sequências separadas com piso atômico. Na
auditoria de 03/11/2026 a produção tinha somente `main = 1023` (sem as linhas
`demandas`, `calculistas` ou `clientes`), que a v5 cria no primeiro uso. Esses
harnesses foram seguidos pelo rollout real no Supabase; a validação de RLS por
identidade continua pendente porque a autenticação é client-side.

Na mesma sessão local foram executadas 20 chamadas concorrentes à RPC de
sequência (20 IDs únicos, 1024–1043), a regravação dos 796 agregados pela RPC
(42,4 s, zero falhas, contagens e créditos idênticos) e exportações CSV reais.
Também foram disparadas 20 conclusões concorrentes do mesmo cálculo: uma
transição efetiva, 19 idempotentes e um único crédito/data. O backup exportado
passou em `validateBackupPayload` e os 796 agregados passaram na
normalização/validação; o fluxo completo de `FileReader`/importação no navegador
não foi reexecutado contra o PostgREST real.

Em 04/11/2026 a produção já tinha crescido para **843 demandas, 792 reclamantes,
726 entregues e `main = 1071`**. Foi capturado um backup completo somente leitura
(1.187.431 bytes; SHA-256
`385964cc73b78bf9143a79892a49c89dbc26e1134967df7edc7b68ee6de04b1a`) e um ensaio
local com esses dados aplicou a v4, as colunas legadas, o trigger de conclusão e
a v5 duas vezes. Resultado: 843/792/843/843, 726 créditos, zero exceções,
`main = 1071` e primeira nova demanda `DLS-1072`. Nenhuma escrita foi feita no
Supabase durante o ensaio.

### Rollout e E2E de produção (04/11/2026)

Antes da escrita foi criado um snapshot consistente no schema
`dls_backup_v5_20261104` e aplicado `dls_calculistas_metricas.sql`; a v5 foi
executada em cerca de 2 s, o schema cache foi recarregado e o deploy do frontend foi
publicado. Uma segunda execução da v5, após o deploy, cobriu a janela de
transição sem alterar as contagens.

O teste transacional real, terminando em `rollback`, exercitou a sequência
(`DLS-1103`), uma demanda coletiva com 2 reclamantes/2 cálculos, principal
único, conclusão idempotente, correção de crédito, preservação do crédito em
re-save, reabertura e exclusão. O teste pela API REST pública criou, leu,
concluiu, reabriu e excluiu outra demanda de teste; todos os filhos remanescentes
foram conferidos como zero. Nenhum resíduo de teste ficou em produção.

O backup pós-migração tem 871 demandas, 812 reclamantes, 871 cálculos, 871
vínculos e 752 créditos; a validação do payload retornou `valid: true` e zero
erros, sem principal ausente/duplicado. O arquivo e o SHA-256 estão na seção
“Status de produção”.

## Segurança e limitações conhecidas

- **A autenticação atual é client-side.** O DLS usa a chave anon pública do
  Supabase e identifica o usuário em `dls_user_profiles`; não há Supabase Auth
  nem JWT por usuário. Por isso, as políticas RLS novas mantêm o modelo existente
  (`anon`/`authenticated` com acesso total) e a segregação por perfil é aplicada
  apenas pela camada `AUTH`/`DB` no navegador.
- Consequência: as regras de negócio do agregado são garantidas pelas RPCs, mas
  as permissões de concluir cálculo, alterar status/entregar demanda e as restrições
  administrativas para criar demanda coletiva, reabrir/corrigir crédito e excluir
  demanda são aplicadas **somente na interface**. Um usuário que possua a anon key
  pode chamar REST/RPC diretamente. O requisito T33 da especificação só será
  plenamente atendido com uma reconstrução de autenticação (Supabase Auth + RLS
  baseada em identidade).
- As RPCs são `SECURITY INVOKER`; os grants para `anon`/`authenticated` são
  intencionais para manter o funcionamento atual. Não trate a anon key como
  segredo.
- As migrações v5 e v6 são aditivas e já foram ensaiadas e aplicadas em
  produção. Para novas alterações, mantenha o ensaio em cópia de homologação e o
  backup validado; não há rollback automático de dados.
- A view e o frontend usam o fuso `America/Sao_Paulo` para agrupar a data de
  conclusão dos cálculos.
- Datas sem hora são tratadas como datas civis e não passam por conversão UTC.
  `timestamp without time zone` do banco é interpretado como instante UTC;
  valores de formulários `datetime-local` são convertidos de
  `America/Sao_Paulo` para UTC. Históricos antigos sem offset são lidos como
  horário de parede de São Paulo. Nomes de exportação e backup usam a data
  operacional de São Paulo.
- `AUTH.getProfiles()` e `AUTH.loadProfile()` solicitam apenas as colunas
  públicas do perfil. `password_hash`/`password_salt` são buscados somente nos
  fluxos internos de login e criação do primeiro administrador. A lista e a
  restauração de sessão não transportam segredos até o navegador.
- A visibilidade de demandas de usuário comum continua baseada no responsável
  principal, no id de perfil permitido e em `allowed_user_ids`. Pertencer à
  equipe ou executar um cálculo **não concede** acesso por inferência; essa
  separação é intencional e segue a especificação. O alerta crítico usa a base
  completa apenas para detectar atrasos do calculista, sem renderizar detalhes
  de demandas fora do escopo. A página de calculistas só é renderizada para
  perfis com `calculistas.view`, evitando agregar dados ocultos na carga inicial.
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
- **Rollback apenas do frontend:** restaure o deploy anterior `dd6ce7c` (v5/v6
  sem a otimização de exportação) ou outro commit desejado. As tabelas v5/v6
  permanecem e os dados não são apagados. Um frontend anterior à v6 não classifica
  conclusões e pode gravar entregas diretas; use apenas em incidente controlado e
  reaplique a v6 antes de reabrir o uso normal.
- **Rollback completo do banco:** não há snapshot point-in-time completo desta
  janela. O schema `dls_backup_v5_20261104` e o backup externo de 04/11 são
  históricos e não contêm os dados posteriores; o snapshot data-only de 25/11
  preserva os dados pré-v5, mas não as tabelas v6. Restaurar qualquer um deles
  perde dados posteriores. Prefira correção para frente e faça um backup completo
  antes de qualquer restore.
- **Incidente pós-implantação:** bloqueie novas escritas na aplicação, exporte o
  estado atual para análise, preserve os logs e aplique uma correção idempotente
  em homologação antes de nova promoção.
- **Rollback da v6:** a v6 é aditiva e não remove estruturas v5. Para desligar a
  funcionalidade, reverta o frontend; as tabelas de conclusão podem permanecer
  sem uso. Não apague `dls_demanda_conclusoes` ou
  `dls_demanda_impugnacao_itens` sem exportar o histórico e obter autorização.
  Se houver defeito, corrija o frontend/migração e reaplique; um restore para o
  estado anterior à v6 exige um snapshot completo que não foi capturado nesta
  janela.

## Documentação de implementação

Consulte `IMPLEMENTACAO_DEMANDAS_COLETIVAS.md` para o relatório detalhado de
arquivos, modelo de dados, regras, testes executados, limitações e checklist de
rollout.
