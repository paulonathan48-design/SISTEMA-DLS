# Implementação — Demandas Coletivas v5

**Status:** implementação concluída. A v5 está em produção desde 04/11/2026 e
foi reaplicada com a reconciliação do legado e a v6 em **25/11/2026**, no
Supabase `mttqsfawxnrotabjfiym`. O schema do PostgREST foi recarregado, o
frontend v5/v6 foi publicado na Vercel (commit `57430ab`) e a produção já
registra conclusões/impugnações v6. Não há staging Supabase separado; o ensaio
foi feito em PostgreSQL 17.6 local com dados reais e a validação final foi
executada no próprio Supabase de produção. O detalhamento do rollout está na
seção 18.

Referência: `C:\Users\paulo\Downloads\DLS_Especificacao_Demandas_Coletivas_v2.md`.

## 1. Escopo entregue

- Demandas coletivas e individuais com múltiplos reclamantes.
- Equipe de responsáveis com exatamente um principal ativo e co-responsáveis
  explícitos.
- Cálculos filhos com executor, escopo, reclamante, prazo efetivo, status e valor.
- Conclusão transacional com crédito e data congelados; reabertura e correção de
  crédito auditadas.
- Contagem de produtividade por cálculo, separada dos indicadores legados de
  demanda.
- Busca, detalhe, edição, filtros, relatórios, exportação e ficha do calculista.
- Conversão/backfill de demandas legadas sem apagar ou reinterpretar silenciosamente
  os dados existentes.
- Backup/importação com filhos v5, validação de referências, mesclagem de catálogos
  e limpeza somente depois das gravações.
- Migração aditiva e idempotente, RPCs, view de produtividade e relatório de
  validação.
- Exclusão transacional de demanda; proteção contra exclusão de reclamante com
  cálculo.

Não faz parte do escopo entregue: autenticação de servidor por usuário. A
limitação está detalhada na seção 9.

## 2. Arquivos

### Criados

| Arquivo | Conteúdo |
| --- | --- |
| `dls_demandas_coletivas.js` | Módulo de domínio compartilhado. Normalização de modalidade/escopo/status, validade do agregado, regra de equipe, cálculo aberto/concluído, congelamento de crédito, prazos, métricas, conversão legada, validação de backup, detecção de backup v5 e escaping HTML. |
| `dls_migration_v5_demandas_coletivas.sql` | Migração completa v5, em transação única. |
| `tests/domain.test.js` | Testes de regras de domínio, legado, backup, métricas e escape. |
| `tests/sql.test.js` | Testes estáticos de estrutura, idempotência, constraints, RPCs e grants. |
| `tests/client.test.js` | Invariantes estáticas do frontend: data histórica, estado de erro, reset, paginação, exportações, logotipo e regressão de TDZ no XLSX. |
| `assets/dls-logo.jpg`, `assets/dls-logo-mark.png` | Logotipo oficial completo e marca compacta, também embutidos como data URI no `index.html`. |
| `IMPLEMENTACAO_DEMANDAS_COLETIVAS.md` | Este relatório. |

### Alterados

| Arquivo | Alteração |
| --- | --- |
| `index.html` | UI de reclamantes/equipe/cálculos, filtros, detalhe, relatórios, ações de conclusão/reabertura/correção, importação/exportação, exclusão transacional, cache, identidade visual DLS, impressão e compatibilidade legada. |
| `README.md` | Instalação, ordem de migração, validação, limitações de segurança, testes, reset e rollback. |

O módulo JS, o SQL, os testes e este relatório fazem parte do histórico
versionado da implementação; a correção de sequência foi adicionada após a
validação em PostgREST e está coberta pelos testes. `README.md` e `index.html`
foram atualizados no mesmo conjunto.

## 3. Modelo de dados

### Demanda principal

Acréscimos aditivos em `public.dls_demandas`:

| Coluna | Tipo | Regra |
| --- | --- | --- |
| `modalidade_demanda` | `text` | `individual` ou `coletiva`; default `individual`, `NOT NULL`, check. |
| `valor_estimado` | `numeric(15,2)` | Honorários/valor estimado; separado de resultado de cálculo. |
| `concluida_em` | `timestamptz` | Garantida pela migração; o trigger oficial `dls_set_concluida_em` continua sendo a autoridade nas transições comuns. |

`dls_demandas.tipo`, prazo, status, SLA, `responsavel_id`, histórico e comentários
continuam sendo a fonte dos indicadores de demanda.

### Tabelas filhas

#### `public.dls_demanda_reclamantes`

- `id text` PK.
- `demanda_id` FK para `dls_demandas` com `ON DELETE CASCADE`.
- `nome`, `observacoes`, `ordem`, `ativo`, `legado_principal`, timestamps.
- `UNIQUE (id, demanda_id)`.
- Um único reclamante `legado_principal` ativo por demanda (índice parcial).
- Nome não vazio (`btrim`).

#### `public.dls_demanda_calculos`

- `id text` PK; `demanda_id` FK.
- `reclamante_id` opcional, com FK composta `(reclamante_id, demanda_id)` para
  `dls_demanda_reclamantes(id, demanda_id)`, impedindo reclamante de outra demanda.
- `escopo` (`individual`/`coletivo`); cálculo coletivo não pode ter reclamante.
- `tipo` obrigatório; `origem_calculo` e `prazo` próprios.
- `calculista_executor_id`: executor atual; obrigatório para cálculo novo ativo.
- `status`: `pendente`, `andamento`, `revisao`, `aguardando`, `entregue`,
  `cancelada`.
- `valor_resultado`; `ativo`; `ordem`; observações.
- `concluido_por_calculista_id`: crédito oficial, nulo até conclusão.
- `concluido_em`: data/hora real da conclusão do cálculo.
- `origem_registro`: `legado` ou `novo`.
- Flags de legado: `legado_principal`, `legado_sem_reclamante`,
  `credito_legado_presumido`.
- Check de conclusão: cálculo entregue exige data (exceto legado) e cálculo não
  entregue não pode manter crédito/data.
- FK composta de reclamante com `ON DELETE RESTRICT`.

#### `public.dls_demanda_responsaveis`

- `id text` PK; `demanda_id` FK; `calculista_id` FK para `dls_calculistas`.
- `papel` (`principal`/`co_responsavel`), `ativo`, auditoria.
- `UNIQUE (demanda_id, calculista_id)`.
- Índice parcial garante no máximo um principal ativo por demanda.
- Trigger sincroniza `dls_demandas.responsavel_id` com o principal ativo.
- A FK de calculista é `ON DELETE RESTRICT` para preservar histórico; a
  inativação do vínculo é o caminho normal.

### View e funções

- `public.vw_dls_calculos_produtividade`: uma linha por cálculo, com reclamante,
  executor, status, prazo efetivo, crédito, data, dia em
  `America/Sao_Paulo`, flags de legado e `ativo`.
- `public.dls_salvar_demanda_coletiva(p_demanda, p_reclamantes, p_calculos,
  p_responsaveis)`: gravação transacional do agregado, com advisory lock,
  validação de IDs/referências/equipe/escopo, upsert e retorno do agregado.
- `public.dls_concluir_calculo(p_calculo_id, p_executor_creditado_id, p_usuario)`:
  conclusão atômica e idempotente; valida cálculo ativo, crédito e vínculo do
  executor com a equipe ativa.
- `public.dls_reabrir_calculo(p_calculo_id, p_motivo, p_usuario)`: reabertura
  auditada; limpa crédito e data.
- `public.dls_corrigir_credito_calculo(p_calculo_id, p_novo_credito_id,
  p_motivo, p_usuario)`: correção administrativa auditada, restrita a cálculo
  entregue e calculista válido.
- `public.dls_excluir_demanda_completa(p_demanda_id)`: exclusão transacional com
  lock; remove cálculos, reclamantes, equipe e demanda na ordem correta.
- `public.dls_relatorio_migracao_v5()`: contagens e exceções do backfill.
- `public.dls_next_demand_sequence(p_last_used)`: gera o próximo `DLS-*` com o
  maior ID conhecido como piso atômico.
- `public.dls_next_sequence(sequence_name, default_value)`: versão reforçada da
  sequência genérica; eleva a linha existente ao piso antes de incrementar.
- `public.dls_set_updated_at()` e `public.dls_validar_calculo()`: timestamps e
  invariantes de cálculo.
- `public.dls_sincronizar_responsavel_principal()`: mantém o principal em
  `dls_demandas.responsavel_id`.

## 4. Regras de negócio implementadas

### Equipe versus crédito

- A equipe operacional é uma relação explícita; **não** é `allowed_user_ids`.
- Exatamente um principal ativo por demanda.
- Um cálculo em aberto exige executor que pertença à equipe ativa.
- Um cálculo já concluído preserva executor histórico e crédito mesmo que esse
  calculista seja removido da equipe depois. O crédito não é recalculado por
  mudança de principal ou co-responsáveis.
- Novos cálculos usam o principal como sugestão, mas o usuário autorizado pode
  escolher outro membro da equipe. Pessoas não são adicionadas silenciosamente.

### Conclusão, reabertura e correção

- A conclusão registra, na mesma operação, status entregue, crédito e
  `concluido_em`.
- Conclusão repetida do mesmo crédito é idempotente; não gera duas unidades.
- Cálculo cancelado ou inativo não pode ser concluído.
- Reabertura limpa crédito/data e exige motivo; nova conclusão usa o estado
  vigente, não os eventos anteriores.
- Correção de crédito é administrativa, exige motivo e fica registrada no
  histórico.
- Cálculo concluído é protegido contra alteração direta de crédito/data/executor
  fora das RPCs auditadas.

### Status da demanda

- O status global continua sob as regras existentes; status de cálculo não o
  altera automaticamente.
- Uma demanda entregue não pode manter cálculo ativo em aberto. Cálculos marcados
  como entregues no formulário são salvos primeiro em aberto, concluídos pelas
  RPCs auditadas e só então o status global é aplicado.
- Essa regra vale para demandas individuais e coletivas com cálculos.
- Ao editar somente status, usuários não administradores não podem alterar
  equipe, reclamantes, cálculos ou crédito; essa é uma regra de interface.
- Concluir cálculos e alterar o status/entregar demandas são permissões próprias
  (`calculos.concluir` e `demandas.entregar`), habilitadas por padrão para o papel
  `user` e configuráveis por usuário em Configurações > Usuários. A reabertura
  de demanda já entregue exige `demandas.manage`; reabrir cálculos e corrigir
  crédito continuam exclusivos de administradores.
- O reset do banco é bloqueado quando a estrutura v5 está presente.

### Prazos e métricas

- Prazo efetivo do cálculo = prazo do cálculo ou, na ausência, prazo da demanda.
- Atraso de cálculo é calculado no cálculo aberto e não sobrescreve o SLA da
  demanda.
- A unidade de produção é cada linha de cálculo ativo, contada uma vez pelo
  crédito vigente.
- Cálculos concluídos entram no período pela data do cálculo
  (`concluido_em`), não por `dls_demandas.concluida_em`.
- O total histórico inclui crédito legado sem data; esse registro não entra em
  dia/mês/período e é sinalizado por `*`.
- “Demandas concluídas” continua separado e usa a regra legada em
  `dls_demandas`.
- A data de agrupamento no frontend e na view usa `America/Sao_Paulo`.
- A ficha do calculista mostra carga/demandas, demandas concluídas, participação
  na equipe e produção de cálculos com rótulos distintos.

### Backfill legado

- Executado somente para demandas que ainda não possuem nenhum filho.
- `reclamante` antigo vira reclamante principal.
- `responsavel_id` válido vira membro principal e executor do cálculo legado.
- Demanda entregue com `concluida_em` copia a data para o cálculo legado.
- Crédito legado presumido é preenchido a partir de `responsavel_id`, marcado por
  `credito_legado_presumido` e reportado no relatório. Essa é uma premissa
  explícita, não uma regra para cálculos novos.
- Cálculo legado entregue sem data não entra em métricas de período; sem
  responsável válido, não recebe crédito.
- IDs legados determinísticos evitam duplicação em reexecução.

## 5. Interface e compatibilidade

- `index.html` carrega `dls_demandas_coletivas.js` antes do script principal.
- A seção de detalhe/edição exibe reclamantes, equipe e cálculos.
- Ações de conclusão solicitam/confirmam o executor creditado e usam RPC.
- O editor permite adicionar co-responsáveis e escolher executor por cálculo.
- Filtros globais e de relatório incluem reclamantes e tipos de cálculo.
- Tabelas, cards, CSV/XLSX e detalhe de produtividade mantêm um registro por
  cálculo. O XLSX detalhado inclui abas `Demandas`, `Reclamantes`, `Equipe` e
  `Calculos`, preservando IDs e vínculos.
- Demandas antigas sem filhos continuam legíveis; a UI degrada para os dados
  legados quando a migração v5 não está aplicada.
- O backup exporta filhos embutidos e no topo; a importação detecta backup v5
  centralmente em `DLSDomain.backupLooksLikeV5`.
- Backups legados (`versao: 2`, sem filhos) seguem o caminho antigo e são
  convertidos de forma compatível.
- A importação valida referências cruzadas, IDs duplicados/vazios e agregados
  antes de gravar; catálogos são mesclados por upsert.
- Demandas ausentes só são removidas depois de todas as gravações de demanda
  terem sucesso; falhas são reportadas sem esconder lote parcial.
- A exclusão de demanda usa RPC transacional; o cache só é alterado depois do
  sucesso.

## 6. Migração e idempotência

- O script completo está entre `begin;` e `commit;`.
- Usa `if not exists` para tabelas/colunas/índices.
- Antes de recriar constraints/FKs, usa `drop constraint if exists`.
- Funções, triggers, políticas e grants usam `create or replace`/`drop ... if
  exists` quando aplicável.
- O backfill é condicional e determinístico; rodar novamente não duplica filhos.
- O relatório `dls_relatorio_migracao_v5()` permite conferência após a execução.
- A migração foi aplicada **duas vezes** no PostgreSQL embarcado e **duas vezes**
  no PostgreSQL 17.6 real de validação, sem erro e sem alterar contagens.
- No Supabase de produção, a v5 foi aplicada em 04/11/2026 e reaplicada após o
  deploy (cerca de 2 s por execução), sem erro e sem alterar as contagens. O schema
  cache do PostgREST foi recarregado com `notify pgrst, 'reload schema'`.

## 7. Testes executados

### Auditoria somente leitura do banco de produção

A leitura somente leitura mais recente, em 04/11/2026, foi feita pela API REST
do projeto, sem nenhuma escrita. A linha de base encontrada foi:

- 843 demandas; 792 com `reclamante` preenchido; 726 entregues, todas com
  `concluida_em`; 117 não entregues, todas sem `concluida_em`; todas com
  `responsavel_id` válido em `dls_calculistas` (nenhum responsável órfão);
- 12 calculistas, 30 clientes, 14 perfis, 4 reuniões e 1.880 logs;
- tabelas e colunas da v5 ainda ausentes; sequência `main = 1071`; maior ID
  existente `DLS-1071`, com 843 IDs únicos.

A auditoria anterior (03/11/2026) tinha 796 demandas, 749 com reclamante, 718
entregues e `main = 1023`; o crescimento é esperado. O backup completo de dados
dessa leitura pré-migração tem 1.187.431 bytes e SHA-256
`385964cc73b78bf9143a79892a49c89dbc26e1134967df7edc7b68ee6de04b1a`.

### Linha de base final de produção

Após a migração e o deploy, a leitura de 04/11/2026 encontrou:

- **871 demandas, 812 reclamantes, 871 cálculos e 871 vínculos de equipe**;
- **752 cálculos concluídos com crédito e data**, 12 calculistas, 30 clientes,
  1.949 logs e 5 reuniões; ainda **0 demandas coletivas** cadastradas;
- `dls_relatorio_migracao_v5()` com `excecoes_legado: []`, zero principal
  duplicado/ausente e zero cálculo ativo sem principal;
- `main = 1102`, maior ID `DLS-1102`; o próximo ID é **DLS-1103**;
- nenhuma linha de teste residual (`DLS-E2E-*` ou `DLS-1103`).

O backup pós-migração tem 4.111.209 bytes e SHA-256
`324740f21ce5c28fc6df481a783c18a29ba1dfbdbe1ee383e6e566a482bef587`; passou em
`validateBackupPayload` com zero erros. O snapshot pré-migração está no schema
`dls_backup_v5_20261104` do próprio banco e o backup externo está em
`C:\Users\paulo\Downloads\DLS-backups\`.

Créditos históricos antes da migração, agrupados por `responsavel_id` (a
premissa de crédito legado descrita na seção 9):

| Calculista | Créditos históricos (demandas entregues com data) |
| --- | ---: |
| Arthur (`CALC-119`) | 206 |
| Vinícius (`CALC-167`) | 125 |
| Jonathan (`CALC-164`) | 116 |
| Enzo Massarioli (`CALC-168`) | 96 |
| Heitor Carvalho (`CALC-165`) | 60 |
| Paulo Nathan Dos Santos Silva (`CALC-116`) | 57 |
| Lavínya Lopes (`CALC-166`) | 40 |
| Paola Cristina Dos Santos Silva (`CALC-708`) | 18 |
| Bruno Lucas (`CALC-564`) | 6 |
| Davi Spinetti (`CALC-169`) | 2 |
| Matheus (`CALC-170`) | 0 |
| Isabela Leite (`CALC-171`) | 0 |
| **Total** | **726** |

A soma por calculista (726) é igual ao total de demandas entregues com data,
portanto a premissa não infla nem reduz o total. Esses são os valores de
referência para a conferência pós-migração; a contagem "depois" deve ser feita
pela view, usando `concluido_por_calculista_id` e `concluido_em`. As 51 demandas
sem `reclamante` daquela linha de base geraram cálculo legado marcado com
`legado_sem_reclamante`; isso é esperado e não cria pessoa fictícia.

Créditos apurados após a migração, por `concluido_por_calculista_id`:

| Calculista | Créditos após a migração |
| --- | ---: |
| Arthur (`CALC-119`) | 211 |
| Vinícius (`CALC-167`) | 126 |
| Jonathan (`CALC-164`) | 121 |
| Enzo Massarioli (`CALC-168`) | 97 |
| Heitor Carvalho (`CALC-165`) | 66 |
| Paulo Nathan Dos Santos Silva (`CALC-116`) | 58 |
| Lavínya Lopes (`CALC-166`) | 46 |
| Paola Cristina Dos Santos Silva (`CALC-708`) | 18 |
| Bruno Lucas (`CALC-564`) | 7 |
| Davi Spinetti (`CALC-169`) | 2 |
| Matheus (`CALC-170`) | 0 |
| Isabela Leite (`CALC-171`) | 0 |
| **Total** | **752** |

### Ensaio de migração com a carga atual

Em 04/11/2026, o backup acima foi importado em um banco PostgreSQL 17.6 local
com o schema base, a migração v4 e as colunas legadas de produção, mas **sem a
v5**. Em seguida foram aplicados `dls_calculistas_metricas.sql` e
`dls_migration_v5_demandas_coletivas.sql` duas vezes. O ensaio produziu:

- 843 demandas, 792 reclamantes, 843 cálculos e 843 vínculos de equipe;
- 726 cálculos concluídos com crédito presumido e `excecoes_legado: []`;
- nenhuma demanda sem principal ou com mais de um principal;
- `main = 1071` preservado; primeira nova demanda retornaria `DLS-1072`
  (`dls_next_demand_sequence(1071)` inseriu `demandas = 1072`; teste revertido);
- segunda aplicação da v5 sem alterar contagens.

Nenhuma escrita foi feita no Supabase nesse ensaio.

A paginação da carga inicial também foi exercitada em leitura contra a API real
(páginas de 500): 796 linhas retornadas e 796 IDs únicos, sem truncamento nem
duplicidade.

### Rollout e E2E no Supabase de produção

Antes da migração foi criado um snapshot consistente no schema
`dls_backup_v5_20261104`; em seguida foram aplicados o trigger de conclusão e a
v5, em cerca de 2 s. O schema cache foi recarregado, o frontend foi publicado e a v5 foi
reaplicada para cobrir a janela em que abas antigas ainda podiam gravar.

O teste transacional real, encerrado com `ROLLBACK`, exercitou:

- sequência própria: `dls_next_demand_sequence(1102) = 1103`;
- criação coletiva `DLS-1103` com 2 reclamantes, 2 cálculos, 1 principal e 1
  co-responsável, reclamante legado sincronizado;
- conclusão com crédito/data, segunda conclusão idempotente, correção de crédito
  e preservação do crédito após re-salvar o agregado;
- reabertura com limpeza de crédito/data e nova conclusão pelo co-responsável;
- exclusão transacional, com zero filhos restantes.

O teste pela API REST pública (anon key, mesmo caminho do frontend) criou uma
demanda de teste, leu o agregado, concluiu, reabriu e excluiu. A checagem final
não encontrou linhas `DLS-E2E-*`, nem a demanda transitória `DLS-1103`; as
contagens de produção permaneceram 871/812/871/871 com 752 créditos.

A validação final do frontend em produção carregou 871 demandas, 812
reclamantes, 871 cálculos e 871 vínculos com `hasColetivas: true`,
`relatedDataReady: true`, zero erros de validação e zero principal
duplicado/ausente.

### Verificações de código

```text
node --check dls_demandas_coletivas.js
→ sem erros

node --test tests/domain.test.js tests/sql.test.js tests/client.test.js
→ 44 testes, 44 pass, 0 fail

Extração do JavaScript inline de index.html + `new Function` (sintaxe)
→ 1 script extraído, sem erro
ESLint temporário da revisão inicial
→ sem erros antes da correção de sequência
```

Os testes cobrem, entre outros:

- normalização de modalidade/escopo/status;
- agregado coletivo válido e rejeições de reclamante/equipe/escopo;
- principal único, duplicidade e executor fora da equipe em cálculo aberto;
- preservação de executor histórico fora da equipe em cálculo concluído;
- crédito somente em cálculo entregue com calculista e data;
- congelamento idempotente, reabertura e correção de crédito;
- métricas por crédito, executor, período, histórico sem data e prazo efetivo;
- fuso de conclusão (`America/Sao_Paulo`);
- busca/resumo com todos os reclamantes e tipos;
- conversão legada e validação de backup v5/legado;
- IDs duplicados/vazios, referências cruzadas e escape HTML;
- transação, tabelas, constraints, FK composta, RPCs, backfill, view, RLS/grants;
- restauração de data global e proteção de crédito contra PATCH direto;
- abas detalhadas de reclamantes/equipe na exportação XLSX;
- declaração do domínio antes do primeiro uso na exportação XLSX (regressão de TDZ);
- paginação da carga inicial para não truncar filhos no limite do PostgREST;
- compatibilidade entre cabeçalho e colunas do relatório de cálculos;
- exclusão transacional e `RESTRICT` de reclamante;
- sequência própria de demandas, sequências separadas de calculistas/clientes e
  piso atômico contra IDs legados defasados.

### Validação real de SQL em PostgreSQL embarcado

Foi usado um banco PostgreSQL via PGlite (`@electric-sql/pglite` 0.3.14), com
schema sintético compatível, porque Docker/`psql` não estavam disponíveis no
ambiente. Cenário executado:

1. schema base sintético com 3 calculistas e 3 demandas legadas;
2. aplicação da migração v5;
3. reaplicação da migração para verificar idempotência;
4. relatório de migração e contagens de backfill;
5. bloqueio de exclusão de reclamante com cálculo;
6. criação de demanda coletiva com 2 reclamantes, 2 cálculos e 2 responsáveis;
7. bloqueio de remoção de executor de cálculo aberto da equipe;
8. conclusão idempotente, bloqueio de crédito para executor fora da equipe;
9. troca de equipe após a conclusão, removendo o executor histórico, sem alterar
   crédito/data;
10. conferência da view de produtividade e do dia em `America/Sao_Paulo`;
11. exclusão transacional completa;
12. conferência da data global legada preservada.

Resultado final: `PGLITE-OK`, todas as asserções do cenário verdadeiras.

Isso valida sintaxe, transações, triggers, constraints e RPCs em um PostgreSQL
real, mas **não** substitui testes no Supabase (extensões, RLS, PostgREST,
volume e concorrência reais).

### Validação em PostgreSQL 17 + PostgREST 16.5 local

Em 03/11/2026 foi montado um ambiente local isolado com PostgreSQL 17.6 e
PostgREST 16.5, sem Docker e sem tocar no serviço PostgreSQL existente. Foram
criados cluster, banco, roles, grants e as políticas RLS do schema base; os 796
registros de produção foram lidos somente para leitura pela API e carregados no
banco local. Em seguida foram aplicados `dls_calculistas_metricas.sql` e
`dls_migration_v5_demandas_coletivas.sql` **duas vezes**.

Resultados:

| Conferência | Resultado |
| --- | ---: |
| Demandas / reclamantes / cálculos / equipe | 796 / 749 / 796 / 796 |
| Créditos concluídos | 718, distribuição por calculista idêntica à linha de base |
| `dls_relatorio_migracao_v5()` | `excecoes_legado: []`, zero principal duplicado |
| Segunda aplicação da v5 | contagens inalteradas |
| Carga do app via PostgREST real | 796 demandas carregadas, sem erro de CORS/PostgREST |
| Nova demanda coletiva | `DLS-2026-1024`, dois reclamantes, dois cálculos e dois integrantes |
| Concluir / reabrir / reconcluir | crédito e data congelados; reabertura limpou; reconclusão creditou de novo |
| Remover calculista creditado da equipe | crédito histórico preservado |
| Cálculo aberto com executor fora da equipe | bloqueado pela RPC com HTTP 400 |
| Piso atômico com sequência defasada | sequência em 100 e RPC chamada com 100 retornou `DLS-1024` (maior real 1023) |
| XLSX | 10 abas, incluindo Demandas, Reclamantes, Equipe e Cálculos |
| Backup exportado | 797 demandas, 751 reclamantes, 798 cálculos e 798 vínculos no cenário com teste |
| Exclusão transacional | voltou a 796/749/796/796 e 718 créditos |

O teste encontrou um problema no schema local que reproduzia a carga de
produção: a sequência `main` estava em **100**, embora os dados importados já
possuíssem `DLS-1023`, `CALC-708` e `CLI-1005`. Novos cadastros poderiam receber
IDs antigos (`DLS-101`, `CALC-101`, `CLI-101`). Na auditoria de 03/11/2026 a
produção tinha somente `main = 1023`, sem as linhas `demandas`, `calculistas` ou
`clientes`; as RPCs da v5 criam essas linhas no primeiro uso. A correção:

- `DB.proximaIdentidadeDemanda()` usa `dls_next_demand_sequence`, com o maior ID
  `DLS-*` como piso; a RPC recalcula esse máximo no banco, além do valor enviado
  pelo cliente;
- calculistas e clientes usam sequências separadas (`calculistas`, `clientes`) e
  o maior ID numérico de cada catálogo como piso;
- a v5 redefine `dls_next_sequence` para elevar uma linha existente ao piso antes
  de incrementar;
- a v5 cria as linhas `demandas`, `calculistas` e `clientes` no primeiro uso, com
  piso no maior ID do respectivo catálogo;
- a criação local passou a gerar `DLS-1024`, e os testes de regressão verificam
  esse comportamento;
- em transação que removeu a linha `demandas` (equivalente ao estado de produção),
  `dls_next_demand_sequence(1023)` retornou 1024 e criou a linha com esse valor;
  o `rollback` restaurou a linha local em 1023.

Esse ambiente usa as políticas RLS permissivas do schema base (anon), não
Supabase Auth/RLS por identidade e não substitui staging. A seguir foram
executadas validações adicionais de concorrência, reidratação e exportação real.

### Concorrência, reidratação e exportações reais

- **Concorrência da sequência:** 20 chamadas paralelas a
  `dls_next_demand_sequence(1023)` retornaram 20 IDs únicos, de 1024 a 1043, sem
  erro HTTP. A sequência local foi restaurada para 1023 após o teste.
- **Conclusão concorrente (T29):** 20 chamadas paralelas a
  `dls_concluir_calculo` para o mesmo cálculo retornaram HTTP 200; exatamente uma
  retornou `idempotente: false` e 19 retornaram `idempotente: true`, com um único
  crédito (`CALC-119`) e uma única data de conclusão. A demanda de teste foi
  excluída e a linha de base 796/749/796/796/718 foi restaurada.
- **Reidratação completa:** os 796 agregados carregados foram regravados pela
  própria RPC `dls_salvar_demanda_coletiva`, com `incluirConclusao: true`, em
  **42,4 segundos**, sem falhas.
- **Preservação de dados:** após a reidratação, as contagens continuaram
  796/749/796/796, os 718 créditos mantiveram a mesma distribuição e o relatório
  retornou `excecoes_legado: []`. Hashes de todas as linhas de demandas,
  reclamantes, cálculos e equipe, excluindo apenas `updated_at`/`touched_at`,
  ficaram idênticos aos de um dump anterior ao teste; catálogos também ficaram
  idênticos.
- **Backup real:** o backup exportado pelo app (796 demandas, 749 reclamantes,
  796 cálculos, 796 vínculos, 12 calculistas e 30 clientes) passou em
  `validateBackupPayload`; os 796 agregados passaram em
  `normalizeDemandAggregate` + `validateDemandAggregate`.
- **CSV real:** exportações de demandas (796 linhas + cabeçalho), relatório
  legado (12 calculistas) e produção de cálculos (796 cálculos) foram geradas
  pelo app sem erro.
- **Reset:** continuou bloqueado pela presença da v5.

O fluxo completo de `FileReader`/`importarBackup` no navegador não foi reexecutado
contra o PostgREST real; o parser e a normalização foram validados sobre o backup
real, e a gravação de todos os agregados foi testada pela RPC. A importação
integral em PGlite já havia sido exercitada.

### Migração com a carga real de produção (somente leitura)

Em 03/11/2026 foi executada uma validação adicional sem escrever no Supabase:
os 796 registros reais foram lidos pela API, carregados em um PostgreSQL
embarcado com o schema base equivalente e submetidos ao pré-requisito
`dls_calculistas_metricas.sql` e à migração v5, aplicada duas vezes. Foram
carregados apenas os campos necessários ao backfill (identificador, número,
reclamante, tipo, origem do cálculo, responsável, prazo, status e data de
conclusão); nenhum dado foi gravado no arquivo do repositório.

| Conferência | Esperado da produção | Resultado no PGlite |
| --- | ---: | ---: |
| Demandas migradas | 796 | 796 |
| Reclamantes legados | 749 | 749 |
| Cálculos legados | 796 | 796 |
| Equipe legada | 796 | 796 |
| Créditos legados presumidos | 718 | 718 |
| Cálculos sem reclamante | 47 | 47 |
| Linhas na view de produtividade | 796 | 796 |
| Demandas com mais de um principal ativo | 0 | 0 |
| Entregues sem data de conclusão | 0 | 0 |

A distribuição de créditos por calculista também coincidiu exatamente com a
linha de base da seção anterior (57, 202, 116, 59, 40, 123, 96, 2, 6 e 17,
total 718), e o relatório `dls_relatorio_migracao_v5()` retornou
`excecoes_legado: []`, sem demandas sem principal ou cálculos entregues sem
crédito. A segunda aplicação da migração não alterou nenhuma contagem. Isso
reduz o risco de backfill com a forma real dos dados, mas ainda não valida RLS,
PostgREST, concorrência nem a execução no Supabase.

### Teste E2E local em navegador (PGlite + fachada REST)

Em 03/11/2026 foi executado um harness temporário, **não versionado**, com
PostgreSQL embarcado (PGlite) e uma fachada HTTP compatível com o subconjunto de
PostgREST usado pelo app. A aplicação real (`index.html` e
`dls_demandas_coletivas.js`) foi servida em `localhost` e autenticada com um
perfil admin de teste. A carga inicial veio somente leitura da API de produção
(796 demandas, 12 calculistas e 30 clientes); o banco local recebeu o schema
base, `dls_calculistas_metricas.sql` e a migração v5. Nenhuma escrita foi feita
no Supabase.

| Fluxo executado | Resultado observado |
| --- | --- |
| Login e carga inicial com v5 | 796 demandas, 749 reclamantes, 796 cálculos e 796 vínculos de equipe; sem erro de carga. |
| Criação de demanda coletiva pelo formulário | 2 reclamantes, 2 cálculos e 2 integrantes; persistida e recarregada após `reload`. |
| Concluir, corrigir crédito e reabrir | Total de créditos 718 → 719; correção alterou o creditado sem duplicar; reabertura voltou para 718; reconclusão para 719. |
| Remover da equipe o calculista já creditado | Crédito e data permaneceram congelados; cálculo aberto com executor fora da equipe foi bloqueado; após troca explícita do executor, o salvamento passou. |
| Demanda marcada como entregue com cálculo novo | Salva primeiro em `andamento`, concluída pela RPC, depois marcada como `entregue`; `concluida_em`, crédito e histórico final ficaram corretos. |
| Relatórios e exportações | Relatório renderizou 719 cálculos concluídos; CSV de demandas e de produção incluíram processo/chamado; XLSX gerou 10 abas, incluindo `Demandas`, `Reclamantes`, `Equipe` e `Calculos`. |
| Backup e restauração | Exportou 797 demandas, 751 reclamantes, 798 cálculos e 798 vínculos; a reimportação integral preservou contagens, crédito congelado e vínculo inativo. Reset permaneceu bloqueado. |
| Exclusão transacional | Removeu a demanda de teste e os filhos; 797 → 796 demandas, 751 → 749 reclamantes, 798 → 796 cálculos/equipe e 719 → 718 créditos. |
| Smoke das páginas | Dashboard, Demandas, Kanban, Calendário, Prazos, Reuniões, Calculistas, Clientes, Relatórios, Auditoria e Configurações renderizaram sem exceção. |

O teste encontrou um defeito real de runtime: `exportarRelatorio()` usava
`domain` antes da declaração `const domain = window.DLSDomain`, causando
`ReferenceError` (TDZ) e impedindo a exportação XLSX. A declaração foi movida
para o início da função e foi adicionado um teste de regressão em
`tests/client.test.js`.

Limitações desse harness PGlite: ele não usa PostgREST/RLS reais, não mede
concorrência, não cobre acessibilidade/responsividade e a importação do backup
completo (797 demandas via RPCs sequenciais) levou mais de 30 segundos no
navegador local. O harness PostgreSQL 17 + PostgREST 16.5 usa uma API real; o
rollout posterior no Supabase confirmou o schema, as RPCs e os dados reais. A
validação de RLS por identidade continua pendente porque a autenticação é
client-side.

## 8. O que não foi executado

- Teste E2E completo pela interface de produção com login real, incluindo o fluxo
  `FileReader` de importação de backup no navegador; a criação/conclusão/exclusão
  foi exercitada pelas RPCs reais via SQL e REST, e a carga/validação do frontend
  foi exercitada no navegador de produção sem login.
- Testes de acessibilidade e responsividade no navegador real.
- Testes de concorrência com múltiplos navegadores/usuários reais; a concorrência
  de sequência, conclusão e reidratação foi exercitada nos harnesses locais.
- Importação completa do backup de 871 demandas no navegador real; a validação
  do payload e a leitura paginada foram executadas, mas o tempo de uma restauração
  completa em produção não foi medido.
- Validação de RLS/permissões por usuário no banco (a arquitetura atual não
  fornece identidade de servidor; ver T33 na seção 9).
- Execução dos harnesses locais (PGlite e PostgREST) dentro do CI do repositório;
  eles foram validações temporárias, não testes versionados.

A migração, o deploy, a reaplicação do backfill e os testes transacionais/REST
em produção foram executados; os limites acima são de cobertura de interface,
identidade e operação concorrente real.

## 9. Limitações e riscos conhecidos

### Autorização de banco (T33)

O DLS autentica no cliente com a chave anon e `dls_user_profiles`. As políticas
RLS novas seguem o modelo existente de acesso total para `anon`/`authenticated`;
as RPCs são `SECURITY INVOKER` e os grants permitem execução pelo cliente. A
restrição de administrador é aplicada na UI e na lógica de chamada, mas não
impede chamadas diretas à API com a anon key.

Para atender plenamente T33 seria necessário reconstruir a autenticação com
Supabase Auth, emitir JWT por usuário e escrever políticas RLS baseadas em
identidade/perfil. Isso está fora do escopo desta entrega e está documentado no
README.

### Crédito legado presumido

O backfill assume que `responsavel_id` era o executor do cálculo legado. A
premissa está documentada e marcada por `credito_legado_presumido`. Registros sem
data confiável não entram em métricas de período.

### Fuso e datas

A view e a agregação do frontend usam `America/Sao_Paulo`. A exibição individual
de data/hora usa o locale do navegador; em operação fora do Brasil pode haver
diferença visual, mas a contagem gerencial permanece no fuso definido.

### Reset

O reset foi bloqueado quando v5 está presente. Isso é intencional para preservar
cálculos e créditos; o fluxo de restauração é backup/importação.

### Cobertura E2E

O fluxo funcional foi exercitado nos harnesses locais e, em produção, pelas RPCs
reais via SQL e REST (criação, conclusão, reabertura, correção, preservação de
crédito e exclusão). A interface autenticada completa e o fluxo `FileReader` de
importação ainda não foram reexecutados no navegador de produção. A importação
completa de backup executa uma RPC por demanda; com 797 demandas ela levou mais
de 30 segundos no harness PGlite e o tempo em produção ainda não foi medido.

## 10. Rollout

O rollout de produção foi executado em 04/11/2026:

1. **Concluído:** snapshot no schema `dls_backup_v5_20261104` e backup externo
   validado.
2. **Concluído:** pré-requisitos v4 e trigger `dls_set_concluida_em` confirmados.
3. **Concluído:** `dls_calculistas_metricas.sql` e a v5 aplicados no Supabase de
   produção; schema cache recarregado. Não havia staging Supabase separado; o
   ensaio foi feito no PostgreSQL 17.6 local com os dados reais.
4. **Concluído:** `dls_relatorio_migracao_v5()` retornou zero exceções.
5. **Concluído:** principal único, filhos sem principal, créditos legados, view e
   sequências conferidos; `main = 1102` e próximo ID `DLS-1103`.
6. **Concluído:** frontend publicado na Vercel (commit `e8750f1`).
7. **Concluído:** criação coletiva, conclusão/correção/reabertura, preservação de
   crédito, exclusão e backup foram validados em produção por SQL e REST.
8. **Concluído:** v5 reaplicada após o deploy para a janela de abas antigas.
9. **Em andamento operacional:** monitorar erros de console, respostas 4xx/5xx do
   Supabase, novos IDs e eventuais demandas antigas criadas por abas em cache
   (reexecutar o backfill idempotente se aparecerem).

## 11. Validação mínima — checklist

Os itens de criação, conclusão, reabertura, correção de crédito, preservação de
crédito e exclusão foram executados em produção via SQL/REST. Importação
completa, CSV/XLSX e interface autenticada permanecem cobertos pelos harnesses
locais.

- Criar demanda coletiva com 1 principal + 2 co-responsáveis e 2 reclamantes;
  conferir que o ID é o maior existente + 1.
- Criar 2 cálculos com executores distintos; concluir cada um confirmando o
  crédito.
- Reabrir um cálculo; conferir crédito/data limpos e histórico.
- Corrigir administrativamente o crédito; conferir a contagem no total e no
  detalhe.
- Alterar principal/co-responsáveis depois da conclusão e confirmar que crédito e
  data não mudaram.
- Exportar backup, importar em ambiente limpo e comparar contagens/filhos.
- Importar backup legado `versao: 2` e conferir conversão.
- Gerar relatório por calculista/mês e conferir totais contra o detalhe.
- Exportar CSV/XLSX e confirmar um registro por cálculo.
- Excluir demanda de teste e conferir remoção dos filhos e logs.

## 12. Rollback

### Falha na migração

A transação inteira é revertida. Corrigir o erro e reaplicar; não executar partes
soltas do script.

### Rollback do frontend

Reverter `index.html` para a versão anterior ao commit `e8750f1`. O schema v5
pode permanecer, pois é aditivo; a versão antiga ignora as novas colunas/tabelas.
Demandas criadas por abas antigas após o deploy não terão filhos v5; reexecute o
backfill idempotente antes de retornar ao frontend novo. Não importar backups v5
em frontend antigo.

### Rollback completo

Restaurar o snapshot anterior à migração. Em produção, o snapshot está no schema
`dls_backup_v5_20261104` e o backup externo validado está em
`C:\Users\paulo\Downloads\DLS-backups\`. Não dropar tabelas/colunas manualmente
sem backup e autorização: cálculos, créditos, histórico e relacionamentos podem
ser perdidos.

### Incidente após o rollout

Bloquear escritas, exportar o estado atual, restaurar o snapshot, corrigir e
revalidar em homologação antes de nova promoção.

## 13. Arquivos de deploy

Produção: `https://sistema-dls.vercel.app`, deploy do commit `e8750f1`.

- `index.html`
- `dls_demandas_coletivas.js`
- `dls_migration_v5_demandas_coletivas.sql` (aplicação SQL, não servido)
- `dls_supabase.browser.js` (configuração já existente)
- `vercel.json`

Não há bundler, dependências de runtime adicionais ou build step.

## 14. Atualização v3.0 — conclusão classificada e impugnação (v6)

> **Estado em 13/11/2026 (histórico):** implementação e validação local. A v6
> foi aplicada no Supabase de produção em 25/11/2026; o resultado está na
> seção 18. As referências abaixo preservam o registro da validação local.

### 14.1 Escopo v6

- Conclusão classificada em **Impugnação**, **Concordância**, **Atualização** e
  **Apresentação**, versionada por demanda.
- Histórico imutável de conclusões, com uma única versão vigente e snapshots de
  número da demanda, cliente, modalidade e data oficial.
- Itens de impugnação por cálculo/reclamante, com valores monetários da DLS e da
  outra parte, diferença assinada/absoluta gerada pelo banco e direção
  (`DLS maior`, `Outra parte maior`, `Valores iguais`).
- Entrega de demanda sempre pela RPC auditada; nunca por gravação direta de
  `status = 'entregue'`.
- Reabertura com justificativa obrigatória na interface e no servidor.
- Relatórios, exportação XLSX/CSV, impressão e dashboard com conclusão,
  impugnação, filtros, SLA e produtividade por executor creditado.
- Normalização de `Cálculo Civil` para `Cálculo Cível` e inclusão de `E-Social`.
- Backups v5 e v6 com restauração segura de status/data/conclusões.

### 14.2 Arquivos v6

- `dls_migration_v6_conclusao_impugnacao.sql`
- `tests/v6.test.js`
- `index.html` (classificação, histórico, status inline, dashboard, relatórios,
  exportações, impressão e backup)
- `dls_demandas_coletivas.js` (tipos canônicos, analytics, buckets, SLA,
  validação de backup v6 e helpers de fuso)
- `tests/domain.test.js`, `tests/client.test.js` (regressões)

### 14.3 Modelo e garantias

- `dls_demanda_conclusoes`: versão, tipo, situação, data oficial, snapshots,
  auditoria de reabertura e vínculo composto com a demanda.
- `dls_demanda_impugnacao_itens`: vínculo composto com conclusão, cálculo e
  reclamante da mesma demanda; diferenças `GENERATED`; sem coluna de total.
- Triggers bloqueiam `INSERT/UPDATE/DELETE` diretos fora das RPCs
  (`dls.conclusao_auditada`); RPCs são transacionais, com advisory lock e
  `SECURITY INVOKER`, preservando o modelo de RLS/grants da v5.
- `dls_concluir_demanda`, `dls_alterar_status_demanda` e
  `dls_restaurar_conclusoes_demanda` são as portas de escrita auditadas.
- A restauração v5 (`p_conclusoes = null`) preserva conclusões existentes; a
  restauração v6 (`[]`) substitui a lista. `p_concluida_em` nulo usa a data da
  conclusão vigente restaurada e, depois, a data já existente na demanda.

### 14.4 Validações locais executadas

- PGlite sintético v6, incluindo aplicação dupla, conclusão, impugnação,
  reabertura, restauração sem apagar conclusões, restauração de data exata e
  rejeição de escrita direta.
- Validação somente leitura sobre a carga local de produção v5:
  **874 demandas, 815 reclamantes, 874 cálculos/equipe, 755 créditos,
  12 calculistas e 211 `Cálculo Civil` normalizados**. A v6 foi aplicada duas
  vezes sem alterar contagens, sem conclusões inferidas e com grants para
  `anon`.
- Backup v5 local: 871 demandas, 752 entregues, zero demanda entregue com
  cálculo aberto, crédito/data ausente, reclamante individual múltiplo ou equipe
  inválida.
- Testes estáticos: `domain.test.js` 27/27, `sql.test.js` 17/17,
  `v6.test.js` 10/10, `client.test.js` 23/23 (**77/77** no total); `node --check
  dls_demandas_coletivas.js` e o JavaScript inline sem erro de sintaxe.
- Harness PGlite v6: **29/29 verificações**, incluindo aplicação dupla, upsert de
  demanda entregue, bloqueio de INSERT novo entregue, snapshots imutáveis,
  restauração v5/v6 e limpeza transacional.
- E2E local em navegador com PGlite/fachada REST, banco vazio, login de admin
  local e importação do backup v5 completo de 4,1 MB: **871 demandas e 752
  entregas restauradas sem erro** após corrigir a fachada para converter
  `JSON null` em `SQL NULL`. O backup v5 importado manteve 812 reclamantes,
  871 cálculos/equipe e datas históricas exatas, sem conclusões inferidas.
- E2E v6 em 13/11/2026, do zero: o recorte de 18 demandas (12 entregues, 2
  versões e 1 item) foi importado **duas vezes**; em seguida, o backup v6
  completo (3,7 MB, versão 3) foi importado e **reimportado sobre as 871
  demandas já existentes**. Resultado final: **871 demandas, 753 entregues, 812
  reclamantes, 871 cálculos/equipe, 2 versões de conclusão e 1 item**, zero
  entrega sem data, datas/status exatos e **0 divergências** no comparador. As
  duas cargas completas terminaram com **0 falhas** capturadas; a reimportação
  exercitou o upsert de todas as 753 entregas.
- O E2E v6 encontrou um segundo defeito real: o gatilho `BEFORE INSERT` de
  `dls_demandas` bloqueava o `INSERT ... ON CONFLICT DO UPDATE` usado por
  `dls_salvar_demanda_coletiva` ao salvar uma demanda já entregue. A correção
  permite o upsert somente quando a linha já existe e continua bloqueando a
  criação de demanda nova já entregue; há teste de regressão no PGlite e em
  `tests/v6.test.js`.
- Fluxos de UI exercitados no conjunto completo: granularidade
  mensal/trimestral/anual, SLA com amostra explícita, drill-down de cartões,
  filtros e limpeza para `mes_atual`, relatório de todo o período com **754
  versões de conclusão** (752 legado + 2 v6) e 1 item, XLSX/CSV, impressão
  oficial, reabertura com motivo, rollback de status em falha simulada, reset
  bloqueado e todas as quatro classificações (Impugnação, Concordância,
  Atualização e Apresentação).

### 14.5 O que não foi validado

- Aplicação da v6 no Supabase de produção (proibida nesta entrega).
- RLS por identidade real: a autenticação continua client-side, como na v5.
- Testes autenticados com múltiplos usuários, concorrência entre navegadores,
  acessibilidade e responsividade.
- Restauração integral de um backup de produção no Supabase real.
- Compatibilidade cross-browser e `FileReader` em navegadores antigos.

### 14.6 Implantação local/homologação

1. Parta de banco local/homologação com v5 aplicada.
2. Execute `dls_migration_v6_conclusao_impugnacao.sql` inteiro; confira os
   `NOTICE` de normalização de tipos.
3. Abra o app, confirme a detecção da v6 e importe um backup v5 validado.
4. Verifique conclusões, impugnações, relatórios, XLSX e impressão.
5. Só promova para produção com backup, janela e autorização expressa.

### 14.7 Resultado do E2E local

O harness local usa PGlite em memória, uma fachada REST compatível com o
subconjunto PostgREST usado pelo app e backups locais. Ele não lê nem escreve
no Supabase. O E2E cobre login, dashboard com granularidade, importação de
backup v5 e v6, relatórios, exportações, impressão, reabertura e restauração de
datas.

Resultados reproduzidos:

- backup v5 completo: **871 demandas, 752 entregas, 812 reclamantes, 871
  cálculos/equipe**, zero entrega sem data e zero conclusão inferida;
- recorte v6 importado duas vezes: **18 demandas, 12 entregues, 2 versões de
  conclusão, 1 item de impugnação**, sem falhas e com datas/status exatos;
- backup v6 completo importado após o recorte e depois reimportado sobre as 871
  demandas: **871/753/812/871, 2 versões, 1 item**, zero data ausente, **0
  divergências** em `compare-import.js` e **0 falhas** capturadas em
  `window.__importErrors` nas duas cargas completas;
- exportação de backup v6 revalidada por `validateBackupPayload`: **871
  demandas, 753 entregues, 2 conclusões, 1 item, versão 3, `valid: true`**;
- XLSX com as 13 abas e fuso `America/Sao_Paulo`, sem total financeiro de
  impugnação; aba `Demandas` com 871 linhas, `Conclusoes` com 754 e
  `Impugnacao` com 1; CSV com 871 demandas e `Prazo` em `dd/mm/aaaa`;
- impressão de `DLS-2026-1099` contendo as duas versões, motivo de reabertura,
  item e diferença assinada/absoluta (`-250,00` / `250,00`);
- relatório de todo o período com 754 versões (752 legado + 2 v6), SLA de 53%
  (448 no prazo, 305 após o prazo e 95 em atraso aberto na amostra de 848), sem
  duplicação de demandas coletivas ou total financeiro de impugnação.

Na primeira tentativa de carga integral, em 11/11, dois erros por demanda foram
registrados no console, mas o estado final já era idêntico ao backup. Em 13/11 a
sequência foi repetida do zero com captura de `window.__importErrors` e de
`console.error`: recorte, carga integral e reimportação integral terminaram sem
erros. O evento não foi reproduzido nem exigiu alteração de código; fica
registrado como observação de robustez do harness local, não como divergência de
dados.

O harness é temporário e não faz parte do deploy. A execução integral foi feita
no mesmo harness; o recorte de 18 demandas serviu apenas para exercitar primeiro
o caminho de upsert antes da carga completa.

### 14.8 Correções encontradas durante o E2E

1. **`JSON null` x `SQL NULL` na fachada local.** A RPC de restauração recebia
   `'null'::jsonb` em vez de `NULL` e rejeitava a preservação de conclusões.
   Corrigido apenas no harness local; o PostgREST real já converte esse valor.
2. **Upsert de demanda entregue bloqueado pelo gatilho v6.** O `BEFORE INSERT`
   disparava antes da resolução do `ON CONFLICT` e impedia salvar uma demanda
   já entregue. A migração agora permite o upsert apenas quando a linha existe;
   inserir demanda nova com status `entregue` continua proibido. Coberto por
   PGlite e pelos testes estáticos.
3. **SLA exibia apenas parte da amostra.** O detalhe mostrava concluídas no prazo
   e após o prazo, mas omitia as abertas em atraso usadas no denominador. O
   dashboard e o relatório agora exibem a amostra completa.
4. **`Prazo` do CSV saía em ISO.** O CSV passou a normalizar o prazo para
   `dd/mm/aaaa`, como as demais datas.


### 14.9 Rollback v6

A v6 é aditiva e não remove estruturas v5. Para desligar a funcionalidade,
restaure o frontend anterior; as tabelas v6 podem permanecer sem uso. Não apague
conclusões/itens sem exportar o histórico. Em caso de incidente, bloqueie
escritas, exporte o estado, restaure o snapshot e reaplique a v6 corrigida após
novo ensaio local/homologação.

## 15. Complemento pós-v3.0 — alerta crítico operacional

> **Estado em 13/11/2026:** implementado e validado **somente no ambiente local**.
> Não requer migração, tabela, RPC ou alteração no Supabase. Nenhuma escrita em
> produção foi realizada.

### 15.1 Regra funcional

- **Convocação de reunião:** quando o perfil logado é participante de uma reunião
  futura ou em andamento e ainda não dispensou aquela convocação, o sistema exibe
  um alerta consolidado em tela cheia. A assinatura é
  `id | dataHora | título`; uma nova reunião, ou uma alteração de data/título,
  gera nova convocação. Reuniões encerradas não alertam.
- **Demanda atrasada:** o perfil logado é associado a um cadastro de calculista
  por `calculista_id`/`calculistaId` explícito, e-mail, nome normalizado ou login,
  sempre exigindo correspondência única. São consideradas demandas não
  entregues/canceladas, com status `atrasada` ou prazo anterior à data
  operacional em `America/Sao_Paulo`, das quais o calculista é responsável direto
  ou membro ativo da equipe.
- **Fechamento exclusivo pelo X:** o overlay não fecha por clique no fundo,
  `Escape`, `Tab`, timeout ou qualquer botão interno. O foco é conduzido ao X e a
  rolagem do sistema fica bloqueada enquanto o alerta estiver aberto.
- **Dispensa e repetição:** ao clicar no X, a reunião e a assinatura do conjunto
  de demandas são gravadas por usuário em `localStorage`
  (`DLS_CRITICAL_ALERTS_<userId>`). Demandas atrasadas voltam a alertar quando o
  conjunto de IDs muda ou em novo dia operacional; reuniões já dispensadas não se
  repetem.
- **Gatilhos de verificação:** login/`startApp`, atualização manual, auto-refresh
  de 90 segundos e salvamento de reunião. Não há push em tempo real; um convidado
  já logado recebe o alerta na próxima sincronização.

### 15.2 Implementação

- `index.html`: overlay `criticalAlertOverlay` com `role="alertdialog"`,
  `z-index: 30000`, faixa de emergência, ícone pulsante, cartão rolável e um único
  botão `X`; CSS responsivo e respeito a `prefers-reduced-motion`.
- `dls_demandas_coletivas.js`: funções puras `resolveCalculistaForProfile`,
  `meetingAlertKey`, `pendingMeetingInvites` e
  `overdueDemandsForCalculista`, cobertas por testes de domínio.
- A verificação usa `DB.getAllReunioes()` e `DB.getAllDemandas()` para não
  depender do recorte de visibilidade da tela. O perfil é resolvido contra
  `DB.getCalculistas()`; quando não há correspondência única, nenhuma demanda é
  inventada.
- Não há alteração no schema, nas RPCs, nos backups, na importação ou nas regras
  financeiras de impugnação.

### 15.3 Validações executadas

- `domain.test.js` **27/27**: resolução por vínculo/e-mail/nome/login,
  ambiguidade, demandas vencidas por responsável/equipe ativa e convocações
  futuras/em andamento, encerradas e já vistas.
- `client.test.js` **19/19**: overlay existe, `z-index: 30000`, apenas um botão
  (X), `Escape` não fecha, chamadas nos gatilhos de login/refresh/salvamento e
  persistência da dispensa.
- Suíte completa: **73/73** testes estáticos; PGlite v6 permaneceu **29/29**;
  JavaScript inline **0 erros de sintaxe**.
- Validação manual no navegador local: alerta combinado com **1 reunião e 17
  demandas atrasadas** para o perfil de teste; `Escape`, clique no fundo e clique
  no cartão mantiveram o alerta aberto; o X fechou; a nova verificação não
  reabriu; uma nova reunião reabriu; o texto livre foi escapado corretamente.
- O fluxo real de **salvar reunião** foi exercitado com o admin como participante:
  a reunião foi persistida, o modal fechou e o alerta abriu imediatamente; após o
  X, a reunião de teste foi removida e o estado local limpo. Os atalhos do sistema
  (`Ctrl+N`) ficaram bloqueados enquanto o overlay estava aberto e o foco foi
  conduzido ao X.

### 15.4 Limitações e rollback

- O estado de "já visto" é local ao navegador. Outro navegador/dispositivo do
  mesmo usuário verá a convocação novamente; não há sincronização multi-dispositivo.
- A detecção é por sincronização periódica, não por push/realtime. Para notificação
  imediata em outra sessão seria necessária uma tabela de notificações com RLS e
  RPC/realtime, deliberadamente fora desta entrega.
- A responsabilidade por equipe considera apenas vínculos ativos; a
  correspondência de perfil para calculista exige unicidade e pode não existir em
  bases sem e-mail/nome coincidente. Nesse caso, o alerta de reunião continua
  funcionando, mas o de demanda atrasada não é emitido.
- Rollback: basta restaurar o frontend anterior (`index.html` e
  `dls_demandas_coletivas.js`) e as suítes de teste correspondentes. Não há
  estrutura de banco a remover nem dados de produção a limpar.

## 16. Auditoria final de datas, perfis e visibilidade

> **Estado em 17/11/2026:** auditoria local concluída. A produção continua na
> v5; nenhuma migração, escrita, alteração de RLS ou substituição de dados foi
> executada no Supabase de produção. O aviso “Conclusão classificada ainda não
> habilitada” permanece visível em produção por falta da estrutura v6.

### 16.1 Datas e horários

- Datas sem hora (`data_requisicao`, `prazo`, filtros e nomes de arquivo) são
  datas civis: não passam por conversão UTC e não deslocam um dia.
- `timestamp without time zone` do banco é lido como instante UTC, consistente
  com `now()` e com `datetimeIn`. Valores de formulários `datetime-local` são
  horário de parede em `America/Sao_Paulo` e são convertidos para UTC antes da
  gravação.
- Históricos e comentários antigos sem offset são interpretados como horário de
  parede de São Paulo, não como UTC.
- Os nomes de exportação/backup (`producao_calculos_*`, `relatorio_dls_*` e
  `backup_dls_*`) usam `hojeLocal()`, não a data UTC do navegador.
- Os helpers centrais (`dateOnly`, `todayIso`, `formatDateBR`, `formatTimeBR`,
  `formatDateTimeBR`, `toSaoPauloInput`, `fromSaoPauloInput`, `parseInstant` e
  `isoAddDays`) estão cobertos por testes de domínio e cliente. O SQL de
  produtividade usa `America/Sao_Paulo` e o schema base não usa mais
  `CURRENT_DATE` dependente do fuso do servidor.

### 16.2 Perfis e segredos

- `AUTH.getProfiles()` e `AUTH.loadProfile()` usam `profileSelect()` com uma
  projeção explícita de colunas públicas. `password_hash` e `password_salt` são
  solicitados apenas em `findByLogin()` e no fluxo interno de criação do
  primeiro administrador.
- `normalizeProfile()` continua removendo os segredos como defesa adicional;
  a diferença é que eles não chegam mais ao navegador na lista ou na sessão.
- A projeção foi conferida em modo somente leitura contra a produção com
  `select=id,login,email,nome,role,permissions,active,created_at,updated_at&limit=0`;
  a API respondeu HTTP 200 sem retornar linhas ou dados.
- `renderCalculistas()` retorna antes de consultar/agregar dados quando o
  perfil não possui `calculistas.view`, evitando renderizar uma página oculta
  com métricas globais.

### 16.3 Visibilidade de demandas

- O usuário comum vê demandas cujo `responsavelId` corresponde ao calculista
  resolvido do perfil, cujo id de perfil está permitido na demanda ou cujo
  `allowedUserIds` contém o id do perfil.
- Pertencer à equipe ou executar um cálculo **não concede acesso por
  inferência**. A especificação exige separar usuários autorizados a acessar a
  demanda de calculistas atribuídos ao trabalho; a decisão foi preservar essa
  separação.
- As chamadas de `DB.getAllDemandas()` restantes foram classificadas:
  numeração, balanceamento de carga, exclusão administrativa, relatórios e
  importação/backup restritos, e o alerta crítico. O alerta usa a base completa
  apenas para detectar atrasos do calculista e não renderiza detalhes de
  demandas fora do escopo. Nenhum caminho de lista, dashboard, relatório ou
  exportação de usuário comum ficou usando a base completa.

### 16.4 Validação final

- Suíte estática: **77/77** (27 domínio, 17 SQL, 10 v6, 23 cliente).
- PGlite v6: **29/29**, incluindo migração dupla, snapshots, impugnação,
  restauração v5/v6, bloqueio de escrita direta e limpeza transacional.
- JavaScript inline: **0 erros de sintaxe**.
- O E2E completo de 871 demandas (753 entregues, 812 reclamantes, 871
  cálculos/equipe, 2 conclusões e 1 item) já havia terminado com **0
  divergências** e **0 falhas** contra o backup. Ele não foi reexecutado após
  os últimos ajustes de projeção de perfil e nomes de arquivo; esses ajustes
  são cobertos pela suíte estática e a projeção foi confirmada contra as
  colunas reais de produção. O servidor PGlite é em memória e perde os dados
  quando reiniciado.
- O exemplo `DLS-2026-1099` renderizou “Impugnação vigente versão 2” e o
  snapshot congelado sem o aviso de conclusão não habilitada no ambiente local
  com v6.

### 16.5 Pendências e limites

- **Produção:** a v6 não será aplicada sem autorização explícita, backup
  validado e janela de manutenção. Enquanto isso, o aviso de conclusão é o
  comportamento esperado da v5.
- **E2E:** repetir a carga completa em ambiente local/homologação depois de
  qualquer nova alteração de frontend ou SQL.
- **Segurança:** a autenticação continua client-side, sem Supabase Auth/JWT por
  usuário; a segregação é aplicada por `AUTH`/`DB` no navegador. Testes reais de
  RLS por identidade, concorrência multi-usuário, acessibilidade,
  responsividade e múltiplos navegadores continuam pendentes.
- **Notificações:** a dispensa do alerta crítico é local ao navegador; não há
  sincronização multi-dispositivo nem push/realtime.

## 17. Identidade visual DLS e padronização das exportações Excel (18/11/2026)

### 17.1 Logotipo

- O logotipo oficial fornecido foi otimizado em dois arquivos:
  `assets/dls-logo.jpg` (700×550, 39.062 bytes) para o logo completo e
  `assets/dls-logo-mark.png` (260×261, 16.280 bytes) para a marca compacta.
- Os dois arquivos também foram embutidos em `index.html` como data URI
  (`DLS_BRAND_B64`/`DLS_BRAND`), evitando dependência de rewrite ou de caminho
  estático no Vercel. `applyBrandAssets()` é chamado no boot e preenche todos os
  elementos `data-dls-logo`.
- O logo completo aparece no login, na configuração inicial, no cabeçalho de
  impressão dos relatórios e no histórico impresso da demanda. A marca compacta
  aparece na sidebar, no cabeçalho global, no favicon, ao lado do título de
  Relatórios e no cabeçalho de cada aba do Excel.
- A aba Relatórios ganhou o botão **Imprimir**. A impressão usa
  `window.print()` com a classe temporária `body.dls-printing-report`, CSS
  `@media print`, cabeçalho completo com empresa, data/hora de geração e período,
  ocultação de filtros/ações/sidebar e restauração da classe no evento
  `afterprint`.

### 17.2 Padrão único dos Excel

- `DLS_XLSX` centraliza o padrão: título, “Gerado em”, “Período”, fuso
  `America/Sao_Paulo`, linha em branco, cabeçalho azul, zebrado, autofiltro,
  larguras de coluna e imagem do logo no topo de cada aba.
- `DLS_EXPORT_HEADERS` e os helpers `dlsExportDemandaRows()` /
  `dlsExportCalculoRows()` são compartilhados entre a aba Relatórios e os
  botões de exportação, evitando divergência de colunas ou de tabulação.
- `exportarRelatorio()` usa o mesmo construtor; `exportarDemandas()` e
  `exportarProducaoCalculos()` deixaram de gerar CSV e passaram a gerar `.xlsx`.
  `exportarDemandas()` inclui `Resumo`, `Demandas`, `Reclamantes`, `Equipe` e
  `Calculos`; a produção inclui `Resumo` e `Calculos`. A exportação de demandas
  reutiliza `dlsFilterDemandasList()`, a mesma função de filtros da tabela
  (status, cliente, calculista, reclamante, prazo e busca), e a ordenação atual.
- Após o `xlsx-js-style` montar o livro, o ExcelJS 4.4.0 (CDN) carrega o buffer,
  insere a marca DLS em cada worksheet e regrava o arquivo. Se o ExcelJS não
  estiver disponível, o arquivo é gerado sem imagem e um aviso é registrado no
  console; a exportação não é bloqueada.
- O backup JSON não foi alterado por esse padrão.

### 17.3 Validação executada

- Suíte estática: **77/77** (27 domínio, 17 SQL, 10 v6, 23 cliente).
- O JavaScript inline foi extraído e validado com `new Function`: **0 erros de
  sintaxe**.
- E2E local de permissões em 21/11/2026: um perfil comum (`user`) recebeu as
  permissões padrão `calculos.concluir` e `demandas.entregar`, concluiu o
  cálculo aberto de `DLS-1100` e entregou a demanda como Concordância. A
  conclusão foi gravada com `registrado_por = "Usuario Teste"` e data em
  `America/Sao_Paulo`; os dados de teste foram removidos ao final e o recorte
  local voltou a 18 demandas, 2 conclusões e 1 item de impugnação.
- E2E local de status em 23/11/2026: o mesmo perfil comum alterou `DLS-1101` de
  **Atrasada** para **Em andamento** pelo modal de edição (botão “Salvar Status”)
  e devolveu para **Atrasada** pelo select inline da tabela. As duas transições
  gravaram histórico com o autor correto; a entrega por select no detalhe também
  abriu a classificação v6 e foi concluída como Concordância. Uma demanda já
  entregue manteve o status bloqueado para reabertura pelo perfil comum. Os
  dados de teste foram removidos e o recorte voltou a 18 demandas, 2 conclusões
  e 1 item de impugnação.
- Smoke local autenticado em 18/11/2026 com 12 demandas: login, logo na sidebar
  e no cabeçalho, impressão do relatório, exportação do relatório (13 abas),
  exportação de demandas (5 abas) e exportação de produção (2 abas).
- Nos três arquivos, todas as abas continham 1 imagem, título com fonte 16,
  merges e autofiltro preservados após o pós-processamento; o console não
  registrou erros nem avisos.
- O E2E completo de 871 demandas não foi reexecutado após esta alteração; o
  smoke test usou a carga local menor e não substitui a validação de volume.

### 17.4 Diagnóstico da v6 e perfis de usuário (19/11/2026)

- **Diagnóstico histórico (19/11/2026):** naquele momento a produção estava na
  v5 e as tabelas `dls_demanda_conclusoes`/`dls_demanda_impugnacao_itens` não
  existiam. A v6 foi aplicada em 25/11/2026; as tabelas e RPCs existem e o
  fluxo está em uso (seção 18).
- O diagnóstico técnico com o nome do arquivo SQL passou a ser exibido somente
  para administradores (`AUTH.isAdmin()` ou `settings.manage`). Usuários comuns
  não veem SQL/RLS; no máximo recebem uma mensagem operacional de indisponibilidade.
- A habilitação exige executar `dls_migration_v6_conclusao_impugnacao.sql` no
  SQL Editor do Supabase ou por conexão administrativa. A chave `anon` do
  frontend não executa DDL.
- O roteiro de backup, execução, validação e recarga do schema está no
  `README.md`, seção “Reaplicar/verificar a v6 em produção”.

### 17.5 Correção de desempenho das exportações em escala de produção (24/11/2026)

- Diagnóstico: `dlsExportCalcName()` e `dlsExportClienteName()` chamavam
  `DB.getCalculistas()`/`DB.getClientes()` por célula. `DB.getCalculistas()`
  recalcula métricas e clona todas as demandas; com a base de produção, cada
  exportação fazia milhares de recálculos e travava a aba (o teste com 1.000
  demandas não concluía em 60 s).
- Correção: `dlsExportLookup()` monta uma única vez os mapas de nomes e o
  contexto de domínio/dados relacionados; `dlsExportDemandaRows()` e
  `dlsExportCalculoRows()` recebem esse contexto. Os fallbacks usam
  `DB.get(DB.KEY_CALCULISTAS)`/`DB.get(DB.KEY_CLIENTES)`, sem recalcular
  métricas. `calcNome()` e `clienteNome()` também usam cache invalidado pela
  identidade do cache do DB. O padrão `DLS_XLSX`, o logo e as regras v5/v6 foram
  preservados.
- Validação local com a carga real somente leitura de produção: 1.416 demandas,
  811 reclamantes, 869 cálculos, 876 vínculos de equipe, 31 clientes e 13
  calculistas. Exportações acionadas pela UI: relatório com 13 abas (~9,1 s,
  430.505 bytes), demandas com 5 abas (~3,9 s, 312.426 bytes) e produção com 2
  abas (~1,3 s, 104.758 bytes); sem erros de console e com 1 imagem por aba.
- Validação local v6 com 18 demandas, 2 conclusões e 1 item de impugnação:
  relatório com 13 abas (~0,9 s, 63.423 bytes), demandas com 5 abas (~0,2 s,
  38.907 bytes) e produção com 2 abas (~0,1 s, 28.689 bytes); console sem erros.
- Suíte estática: **77/77**, incluindo novo teste que impede a regressão de
  `DB.getCalculistas()` por linha na exportação. O JavaScript inline foi
  validado com `new Function`.
- Nenhuma escrita, migração ou deploy em produção foi realizado **nessa etapa
  de 24/11**. O rollout de 25/11 está na seção 18.

## 18. Rollout v5 + reconciliação + v6 em produção (25/11/2026)

### 18.1 Pré-migração e backup

- A produção tinha **1.416 demandas**, mas **547 demandas não tinham filhos v5**
  (reclamante/cálculo/equipe). Por isso a v5 idempotente foi reexecutada antes da
  v6, em vez de aplicar somente a v6.
- Foram verificados órfãos, chaves duplicadas e valores inválidos de
  modalidade/escopo; nenhuma inconsistência bloqueante foi encontrada.
- Foi capturado um snapshot **data-only via REST** antes da migração:
  `C:\Users\paulo\Downloads\DLS-backups\prod-backup-2026-11-25T11-21-19-373Z`
  (1.416 demandas, 3.352 logs, 811 reclamantes, 869 cálculos, 876 vínculos e 14
  perfis). A pasta inclui `SHA256SUMS.txt`. O script aplicado e a consulta de
  verificação foram copiados para a mesma pasta. Não foi criado um `pg_dump`
  completo nesta janela.

### 18.2 Migração e reconciliação

- O script combinado (`prod-v5-backfill-reconcile-v6.applied.sql`, 120.325
  bytes) executou, em uma única transação no SQL Editor do Supabase:
  1. reaplicação idempotente da v5 e backfill dos filhos ausentes;
  2. reconciliação de demandas entregues cujos filhos legados estavam
     desatualizados em relação aos campos atuais de `dls_demandas`;
  3. correção em massa de cálculos legados principais que permaneciam abertos
     em demandas já entregues;
  4. aplicação da v6, normalização de tipos e recarga do schema cache.
- A tabela temporária `_dls_bulk_legacy_open` foi usada no caminho em massa e
  removida no `commit`; a auditoria de cálculos já entregues foi atualizada com
  `dls.calculo_auditado=on`.
- Resultado da reconciliação: **103 demandas** entregues com cálculo legado
  aberto corrigidas (98 no caminho em massa + 5 direcionadas); **9 demandas**
  receberam tratamento específico e **5 delas** também têm o marcador em massa.
  **498 linhas de demanda** e **495 linhas de cálculo** foram normalizadas para
  `Cálculo Cível`.
- Verificação imediatamente após a transação:
  - 1.416 demandas, 1.347 reclamantes, 1.416 cálculos e 1.423 vínculos;
  - zero demanda sem filhos;
  - zero cálculo aberto em demanda entregue;
  - zero `bulk_pendentes`;
  - zero cálculo entregue sem crédito;
  - zero demanda com mais de um principal ativo;
  - tabelas v6 com RLS habilitado e uma política cada;
  - RPCs `dls_concluir_demanda`, `dls_alterar_status_demanda` e
    `dls_restaurar_conclusoes_demanda` presentes.

### 18.3 Deploy e smoke de produção

- O frontend v5/v6 foi publicado primeiro no commit `dd6ce7c` e depois recebeu a
  otimização de exportação no commit `57430ab`, ambos na Vercel. O domínio
  `https://sistema-dls.vercel.app` serve a versão atual; o deploy protegido
  `sistema-gt820eue9-pn-sistemas.vercel.app` não é usado no smoke.
- Login administrativo, dashboard, logo e navegação foram validados sem erros de
  console. O dashboard exibiu 1.416 demandas no momento inicial.
- Exportações com a base completa:
  - **Demandas:** `demandas_dls_2026-11-25.xlsx`, 391.963 bytes, ~2,5 s, abas
    `Resumo`, `Demandas` (1.415 linhas), `Reclamantes` (1.346), `Equipe`
    (1.422) e `Calculos` (1.415).
  - **Produção de cálculos:** `producao_calculos_2026-11-25.xlsx`, 153.000
    bytes, ~0,8 s, abas `Resumo` e `Calculos` (1.415 linhas).
  - **Relatório completo:** `relatorio_dls_2026-11-25_completo.xlsx`, 533.116
    bytes, ~4,2 s, 13 abas, incluindo `Conclusoes` e `Impugnacao`.
- Todos os arquivos mantiveram o padrão `DLS_XLSX`, o logo DLS em cada aba
  (drawings + `xl/media/image1.png`), cabeçalhos, autofiltro e tabulação. O
  relatório caiu de ~11–14 s para ~4,2 s após reutilizar o `Intl.DateTimeFormat`
  no módulo de domínio; a suíte estática passou a **78/78**.
- Após o deploy, usuários reais já criaram **32 conclusões** (incluindo
  impugnações) e **18 itens de impugnação**. O fluxo v6, o histórico versionado
  e as permissões padrão de usuário comum estão operando em produção.
- Os perfis temporários `smoke.admin` e `smoke.user` foram removidos; a produção
  voltou a ter **14 perfis reais**.

### 18.4 Contagem final e observações

- Durante o smoke, uma demanda de produção (`DLS-2026-1698`) foi excluída por um
  administrador às 09:31 de `America/Sao_Paulo`. A exclusão removeu os filhos em
  cascata e explica a contagem final de **1.415 demandas, 1.346 reclamantes,
  1.415 cálculos e 1.422 vínculos**. Não foi uma perda da migração e a demanda
  não foi restaurada, pois a exclusão foi uma ação real de produção.
- Limitações que permanecem: a autenticação é client-side (a anon key não é
  segredo e as permissões de UI não substituem RLS por identidade); não há
  snapshot point-in-time completo desta janela; a importação integral de um
  backup de produção no navegador não foi reexecutada neste rollout. O caminho
  recomendado para incidentes é correção para frente, com backup antes de
  qualquer restore.
