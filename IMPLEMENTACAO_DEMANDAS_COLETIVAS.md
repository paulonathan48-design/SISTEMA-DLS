# Implementação — Demandas Coletivas v5

**Status:** implementação de código concluída e validada estaticamente, em
PostgreSQL embarcado e em PostgreSQL 17.6 com PostgREST 16.5 local; **não
aplicada em produção nem em staging Supabase**. Nenhuma escrita foi feita no
Supabase de produção.

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
| `tests/client.test.js` | Invariantes estáticas do frontend: data histórica, estado de erro, reset, paginação, exportações e regressão de TDZ no XLSX. |
| `IMPLEMENTACAO_DEMANDAS_COLETIVAS.md` | Este relatório. |

### Alterados

| Arquivo | Alteração |
| --- | --- |
| `index.html` | UI de reclamantes/equipe/cálculos, filtros, detalhe, relatórios, ações de conclusão/reabertura/correção, importação/exportação, exclusão transacional, cache e compatibilidade legada. |
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
- A migração **não foi aplicada** no Supabase de produção nem em staging real.

## 7. Testes executados

### Auditoria somente leitura do banco de produção

A leitura somente leitura mais recente, em 03/11/2026, foi feita pela API REST
do projeto, sem nenhuma escrita. A linha de base encontrada foi:

- 796 demandas; 749 com `reclamante` preenchido; 718 entregues, todas com
  `concluida_em`; todas com `responsavel_id` válido em `dls_calculistas`
  (nenhum responsável órfão);
- 12 calculistas, 30 clientes e 14 perfis;
- tabelas e colunas da v5 ainda ausentes.

A auditoria anterior (30/10/2026) tinha 766 demandas, 720 reclamantes e 675
entregues; o crescimento é esperado e os números abaixo são a referência atual
para a conferência pós-migração.

Créditos históricos antes da migração, agrupados por `responsavel_id` (a
premissa de crédito legado descrita na seção 9):

| Calculista | Créditos históricos (demandas entregues com data) |
| --- | ---: |
| Arthur (`CALC-119`) | 202 |
| Vinícius (`CALC-167`) | 123 |
| Jonathan (`CALC-164`) | 116 |
| Enzo Massarioli (`CALC-168`) | 96 |
| Heitor Carvalho (`CALC-165`) | 59 |
| Paulo Nathan Dos Santos Silva (`CALC-116`) | 57 |
| Lavínya Lopes (`CALC-166`) | 40 |
| Paola Cristina Dos Santos Silva (`CALC-708`) | 17 |
| Bruno Lucas (`CALC-564`) | 6 |
| Davi Spinetti (`CALC-169`) | 2 |
| Matheus (`CALC-170`) | 0 |
| Isabela Leite (`CALC-171`) | 0 |
| **Total** | **718** |

A soma por calculista (718) é igual ao total de demandas entregues com data,
portanto a premissa não infla nem reduz o total. Esses são os valores de
referência para a conferência pós-migração; a contagem "depois" deve ser feita
pela view, usando `concluido_por_calculista_id` e `concluido_em`. As 47 demandas
sem `reclamante` gerarão cálculo legado marcado com `legado_sem_reclamante`;
isso é esperado e não cria pessoa fictícia.

A paginação da carga inicial também foi exercitada em leitura contra a API real
(páginas de 500): 796 linhas retornadas e 796 IDs únicos, sem truncamento nem
duplicidade.

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
`clientes`); as RPCs da v5 criam essas linhas no primeiro uso. A correção:

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
  esse comportamento.

Esse ambiente usa as políticas RLS permissivas do schema base (anon), não
Supabase Auth/RLS por identidade; não mede concorrência nem substitui staging.
A importação completa do backup não foi repetida nele; a exportação e a exclusão
foram validadas.

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
navegador local. O harness PostgreSQL 17 + PostgREST 16.5 usa uma API real, mas
ainda não o Supabase/RLS por identidade. O E2E em staging com Supabase real
continua pendente.

## 8. O que não foi executado

- Aplicação da migração no Supabase de produção ou staging.
- Testes E2E contra o Supabase real/staging; o fluxo funcional foi exercitado em
  PostgreSQL 17.6 + PostgREST 16.5 locais, com RLS permissiva do schema base,
  sem Supabase Auth/identidade, acessibilidade ou responsividade.
- Testes de concorrência com múltiplos navegadores/usuários reais.
- Testes de volume no Supabase real; a carga de 796 demandas foi exercitada no
  PGlite e no PostgREST local, não no Supabase de produção.
- Validação de RLS/permissões por usuário no banco (a arquitetura atual não
  fornece identidade de servidor).
- Execução dos harnesses locais (PGlite e PostgREST) dentro do CI do repositório;
  eles foram validações temporárias, não testes versionados.

Não há resultados de execução da migração em produção a apresentar. Nenhuma
operação de escrita foi realizada no banco de produção; a auditoria da seção 7
foi somente leitura.

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

O fluxo funcional foi exercitado nos harnesses locais descritos na seção 7,
incluindo PostgREST real, mas ainda não no Supabase real/staging. A importação
completa de backup executa uma RPC por demanda; com 797 demandas ela levou mais
de 30 segundos no harness PGlite e precisa ser medida em homologação antes de ser
usada como rotina operacional.

## 10. Rollout

1. Backup completo e validação do restore em ambiente separado.
2. Confirmar pré-requisitos v2/v4 e `dls_calculistas_metricas.sql`.
3. Aplicar `dls_migration_v5_demandas_coletivas.sql` em homologação e recarregar
   o schema da API se as RPCs novas não aparecerem no PostgREST.
4. Rodar `select public.dls_relatorio_migracao_v5();`.
5. Conferir principal único, filhos sem principal, cálculos legados, view e
   sequências (`demandas` deve estar no maior ID; o próximo cadastro deve ser
   maior+1, não um ID legado).
6. Publicar frontend e limpar cache.
7. Homologar criação/edição/conclusão/reabertura/relatórios/exportação/backup.
8. Repetir em produção com backup, janela e autorização.
9. Monitorar erros de console, respostas 4xx/5xx do Supabase e contagens.

## 11. Validação mínima em homologação

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

Reverter `index.html` para a versão anterior. O schema v5 pode permanecer, pois é
aditivo; a versão antiga ignora as novas colunas/tabelas. Não importar backups v5
em frontend antigo.

### Rollback completo

Restaurar o snapshot anterior à migração. Não dropar tabelas/colunas manualmente
em produção sem backup e autorização: cálculos, créditos, histórico e
relacionamentos podem ser perdidos.

### Incidente após o rollout

Bloquear escritas, exportar o estado atual, restaurar o snapshot, corrigir e
revalidar em homologação antes de nova promoção.

## 13. Arquivos de deploy

- `index.html`
- `dls_demandas_coletivas.js`
- `dls_migration_v5_demandas_coletivas.sql` (aplicação SQL, não servido)
- `dls_supabase.browser.js` (configuração já existente)
- `vercel.json`

Não há bundler, dependências de runtime adicionais ou build step.
