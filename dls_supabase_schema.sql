-- ============================================================
--  DLS · Sistema de Gestão Operacional
--  Schema Supabase — PostgreSQL
--  Gerado para migração do localStorage para banco relacional
-- ============================================================

-- ============================================================
--  EXTENSÕES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================
--  ENUMS
-- ============================================================

CREATE TYPE status_calculista AS ENUM ('online', 'busy', 'offline');
CREATE TYPE especialidade_calculista AS ENUM ('Geral', 'Trabalhista', 'Previdenciário', 'Tributário', 'Cível');

CREATE TYPE tipo_cliente AS ENUM ('municipio', 'orgao', 'privada', 'autarquia');
CREATE TYPE status_relacionamento AS ENUM ('ativo', 'atencao', 'inativo');

CREATE TYPE status_demanda AS ENUM (
  'triagem', 'pendente', 'andamento', 'revisao',
  'aguardando', 'entregue', 'atrasada', 'cancelada'
);
CREATE TYPE prioridade_demanda AS ENUM ('urgente', 'alta', 'media', 'baixa');
CREATE TYPE tipo_calculo AS ENUM (
  'Cálculo Trabalhista',
  'Cálculo Previdenciário',
  'Liquidação de Sentença',
  'Atualização Monetária',
  'Cálculo Tributário',
  'Honorários Advocatícios',
  'Correção Monetária',
  'Cálculo de Rescisão'
);
CREATE TYPE origem_demanda AS ENUM ('E-mail', 'Sistema do cliente', 'Manual', 'Portal', 'Telefone', 'WhatsApp');


-- ============================================================
--  TABELA: calculistas
-- ============================================================
CREATE TABLE calculistas (
  id            TEXT PRIMARY KEY DEFAULT 'CALC-' || nextval('calculistas_seq')::TEXT,
  nome          TEXT        NOT NULL,
  cargo         TEXT        NOT NULL DEFAULT 'Calculista',
  email         TEXT        UNIQUE NOT NULL,
  tel           TEXT,
  espec         especialidade_calculista NOT NULL DEFAULT 'Geral',
  status        status_calculista NOT NULL DEFAULT 'online',
  meta          INTEGER     NOT NULL DEFAULT 20 CHECK (meta >= 0),
  -- Métricas acumuladas (podem ser derivadas via views, mas mantidas para compatibilidade)
  concluidas    INTEGER     NOT NULL DEFAULT 0 CHECK (concluidas >= 0),
  sla           NUMERIC(5,2)         CHECK (sla BETWEEN 0 AND 100),
  ativas        INTEGER     NOT NULL DEFAULT 0 CHECK (ativas >= 0),
  tempo_medio   NUMERIC(5,2)         CHECK (tempo_medio >= 0),   -- em dias
  obs           TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sequência para IDs legíveis
CREATE SEQUENCE IF NOT EXISTS calculistas_seq START 1;


-- ============================================================
--  TABELA: clientes
-- ============================================================
CREATE TABLE clientes (
  id              TEXT PRIMARY KEY DEFAULT 'CLI-' || nextval('clientes_seq')::TEXT,
  nome            TEXT        NOT NULL,
  tipo            tipo_cliente NOT NULL DEFAULT 'municipio',
  cnpj            TEXT,
  cidade          TEXT,
  contato         TEXT,       -- nome do responsável
  email           TEXT,
  tel             TEXT,
  sla_contratado  NUMERIC(5,2) NOT NULL DEFAULT 95 CHECK (sla_contratado BETWEEN 0 AND 100),
  status_rel      status_relacionamento NOT NULL DEFAULT 'ativo',
  total_historico INTEGER     NOT NULL DEFAULT 0,
  obs             TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS clientes_seq START 1;


-- ============================================================
--  TABELA: demandas
-- ============================================================
CREATE TABLE demandas (
  id               TEXT PRIMARY KEY DEFAULT 'DLS-' || nextval('demandas_seq')::TEXT,
  numero           TEXT        UNIQUE NOT NULL,   -- ex: DLS-2025-114
  processo         TEXT,                          -- número do processo judicial
  reclamante       TEXT,                          -- nome do reclamante
  cliente_id       TEXT        NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
  tipo             tipo_calculo NOT NULL,
  responsavel_id   TEXT        REFERENCES calculistas(id) ON DELETE SET NULL,
  prazo            DATE,
  prioridade       prioridade_demanda NOT NULL DEFAULT 'media',
  origem           origem_demanda NOT NULL DEFAULT 'E-mail',
  status           status_demanda NOT NULL DEFAULT 'triagem',
  obs              TEXT,
  data_requisicao  DATE,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE IF NOT EXISTS demandas_seq START 101;


-- ============================================================
--  TABELA: demanda_historico
--  (histórico de movimentações por demanda)
-- ============================================================
CREATE TABLE demanda_historico (
  id          BIGSERIAL   PRIMARY KEY,
  demanda_id  TEXT        NOT NULL REFERENCES demandas(id) ON DELETE CASCADE,
  data        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  texto       TEXT        NOT NULL,
  autor       TEXT        NOT NULL DEFAULT 'Sistema',
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
--  TABELA: demanda_comentarios
-- ============================================================
CREATE TABLE demanda_comentarios (
  id          BIGSERIAL   PRIMARY KEY,
  demanda_id  TEXT        NOT NULL REFERENCES demandas(id) ON DELETE CASCADE,
  autor       TEXT        NOT NULL,
  texto       TEXT        NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
--  TABELA: audit_logs
--  (log de auditoria de ações do sistema)
-- ============================================================
CREATE TABLE audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  data        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  usuario     TEXT        NOT NULL DEFAULT 'admin',
  acao        TEXT        NOT NULL,
  entidade    TEXT        NOT NULL,
  detalhe     TEXT
);


-- ============================================================
--  TABELA: configuracoes
--  (parâmetros gerais do sistema — linha única)
-- ============================================================
CREATE TABLE configuracoes (
  id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- garante 1 linha
  nome_empresa    TEXT        NOT NULL DEFAULT 'DLS — Assessoria e Consultoria Pública e Empresarial',
  cnpj            TEXT        NOT NULL DEFAULT '00.000.000/0001-00',
  meta_sla        NUMERIC(5,2) NOT NULL DEFAULT 95,
  prazo_padrao_dias INTEGER   NOT NULL DEFAULT 5,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garante que só exista uma linha de configuração
INSERT INTO configuracoes DEFAULT VALUES;


-- ============================================================
--  ÍNDICES
-- ============================================================

-- demandas: filtros mais comuns
CREATE INDEX idx_demandas_status          ON demandas(status);
CREATE INDEX idx_demandas_prioridade      ON demandas(prioridade);
CREATE INDEX idx_demandas_prazo           ON demandas(prazo);
CREATE INDEX idx_demandas_cliente_id      ON demandas(cliente_id);
CREATE INDEX idx_demandas_responsavel_id  ON demandas(responsavel_id);
CREATE INDEX idx_demandas_criado_em       ON demandas(criado_em DESC);

-- histórico e comentários
CREATE INDEX idx_hist_demanda_id   ON demanda_historico(demanda_id);
CREATE INDEX idx_coment_demanda_id ON demanda_comentarios(demanda_id);

-- auditoria: ordenação por data
CREATE INDEX idx_audit_data ON audit_logs(data DESC);


-- ============================================================
--  FUNÇÃO: atualizar campo atualizado_em automaticamente
-- ============================================================
CREATE OR REPLACE FUNCTION fn_set_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_calculistas_upd  BEFORE UPDATE ON calculistas  FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();
CREATE TRIGGER trg_clientes_upd     BEFORE UPDATE ON clientes      FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();
CREATE TRIGGER trg_demandas_upd     BEFORE UPDATE ON demandas      FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();
CREATE TRIGGER trg_config_upd       BEFORE UPDATE ON configuracoes FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();


-- ============================================================
--  FUNÇÃO: marcar demandas vencidas automaticamente
--  (equivalente ao "Auto-mark overdue" do JS)
--  Execute via pg_cron ou trigger agendado
-- ============================================================
CREATE OR REPLACE FUNCTION fn_marcar_atrasadas()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  dem RECORD;
BEGIN
  FOR dem IN
    SELECT id, numero
    FROM demandas
    WHERE prazo < CURRENT_DATE
      AND status NOT IN ('entregue', 'cancelada', 'atrasada')
  LOOP
    UPDATE demandas SET status = 'atrasada' WHERE id = dem.id;

    INSERT INTO demanda_historico(demanda_id, texto, autor)
    VALUES (dem.id, 'Prazo vencido — marcado automaticamente como Atrasada', 'Sistema');

    INSERT INTO audit_logs(usuario, acao, entidade, detalhe)
    VALUES ('Sistema', 'Auto-Atrasada', 'Demanda', dem.numero);
  END LOOP;
END;
$$;


-- ============================================================
--  VIEW: vw_demandas_completas
--  (facilita consultas com dados desnormalizados)
-- ============================================================
CREATE OR REPLACE VIEW vw_demandas_completas AS
SELECT
  d.id,
  d.numero,
  d.processo,
  d.reclamante,
  d.tipo,
  d.status,
  d.prioridade,
  d.prazo,
  d.origem,
  d.obs,
  d.data_requisicao,
  d.criado_em,
  d.atualizado_em,
  -- cliente
  c.id             AS cliente_id,
  c.nome           AS cliente_nome,
  c.tipo           AS cliente_tipo,
  c.cidade         AS cliente_cidade,
  c.sla_contratado AS cliente_sla,
  -- responsável
  r.id             AS responsavel_id,
  r.nome           AS responsavel_nome,
  r.espec          AS responsavel_espec,
  -- prazo calculado
  (d.prazo - CURRENT_DATE) AS dias_restantes,
  CASE
    WHEN d.prazo IS NULL                               THEN NULL
    WHEN d.prazo < CURRENT_DATE                        THEN 'overdue'
    WHEN d.prazo = CURRENT_DATE                        THEN 'hoje'
    WHEN (d.prazo - CURRENT_DATE) <= 2                 THEN 'critico'
    WHEN (d.prazo - CURRENT_DATE) <= 5                 THEN 'atencao'
    ELSE 'ok'
  END AS prazo_status
FROM demandas d
JOIN clientes    c ON c.id = d.cliente_id
LEFT JOIN calculistas r ON r.id = d.responsavel_id;


-- ============================================================
--  VIEW: vw_metricas_dashboard
--  (KPIs do painel executivo)
-- ============================================================
CREATE OR REPLACE VIEW vw_metricas_dashboard AS
SELECT
  COUNT(*)                                                       AS total_demandas,
  COUNT(*) FILTER (WHERE status = 'andamento')                   AS em_andamento,
  COUNT(*) FILTER (WHERE status = 'pendente')                    AS pendentes,
  COUNT(*) FILTER (WHERE status = 'triagem')                     AS triagem,
  COUNT(*) FILTER (WHERE status = 'revisao')                     AS em_revisao,
  COUNT(*) FILTER (WHERE status = 'aguardando')                  AS aguardando_cliente,
  COUNT(*) FILTER (WHERE status = 'atrasada')                    AS atrasadas,
  COUNT(*) FILTER (WHERE status = 'entregue')                    AS entregues,
  COUNT(*) FILTER (WHERE status = 'cancelada')                   AS canceladas,
  COUNT(*) FILTER (WHERE prioridade = 'urgente'
                     AND status NOT IN ('entregue','cancelada')) AS urgentes_abertas,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'entregue')
    / NULLIF(COUNT(*),0), 2
  )                                                              AS taxa_conclusao_pct
FROM demandas;


-- ============================================================
--  VIEW: vw_sla_por_cliente
-- ============================================================
CREATE OR REPLACE VIEW vw_sla_por_cliente AS
SELECT
  c.id,
  c.nome,
  c.sla_contratado,
  COUNT(d.id)                                               AS total,
  COUNT(d.id) FILTER (WHERE d.status = 'entregue')          AS concluidas,
  COUNT(d.id) FILTER (WHERE d.status = 'atrasada')          AS atrasadas,
  ROUND(
    100.0 * COUNT(d.id) FILTER (WHERE d.status = 'entregue')
    / NULLIF(COUNT(d.id) FILTER (WHERE d.status IN ('entregue','atrasada')), 0)
  , 2)                                                      AS sla_real_pct
FROM clientes c
LEFT JOIN demandas d ON d.cliente_id = c.id
GROUP BY c.id, c.nome, c.sla_contratado;


-- ============================================================
--  DADOS INICIAIS (SEED) — espelho dos dados do localStorage
-- ============================================================

-- Calculistas
INSERT INTO calculistas (id, nome, cargo, email, tel, espec, status, meta, concluidas, sla, ativas, tempo_medio, obs) VALUES
  ('CALC-1','Ana Luiza Ferreira',  'Calculista Sênior', 'analuiza@dls.com.br','(16) 99999-0001','Previdenciário','online',20,18,97.00,7,1.8,''),
  ('CALC-2','Carlos Mendes',       'Calculista Pleno',  'carlos@dls.com.br',  '(16) 99999-0002','Trabalhista',   'online',18,15,94.00,6,2.1,''),
  ('CALC-3','Juliana Santos',      'Calculista Pleno',  'juliana@dls.com.br', '(16) 99999-0003','Geral',         'busy', 18,14,92.00,8,2.3,'Alta carga'),
  ('CALC-4','Rafael Costa',        'Calculista Junior', 'rafael@dls.com.br',  '(16) 99999-0004','Tributário',    'online',15,11,88.00,4,2.8,'1 demanda atrasada'),
  ('CALC-5','Marcio Oliveira',     'Calculista Junior', 'marcio@dls.com.br',  '(16) 99999-0005','Trabalhista',   'offline',15,9,85.00, 9,3.1,'Sobrecarga');

-- Clientes
INSERT INTO clientes (id, nome, tipo, cnpj, cidade, contato, email, tel, sla_contratado, status_rel, total_historico, obs) VALUES
  ('CLI-1','Município de São Paulo',         'municipio','46.392.140/0001-60','São Paulo — SP',          'Dr. Roberto Alves', 'juridico@prefsp.com.br',   '(11) 3333-0001',98,'ativo',  87,''),
  ('CLI-2','Petroq Industrial S.A.',         'privada',  '12.345.678/0001-90','Campinas — SP',           'Dra. Sandra Lima',  'juridico@petroq.com.br',   '(19) 3333-0002',95,'atencao',45,'SLA abaixo da meta'),
  ('CLI-3','Município de Ribeirão Preto',    'municipio','56.024.581/0001-62','Ribeirão Preto — SP',     'Dr. Fábio Torres',  'juridico@prib.com.br',     '(16) 3333-0003',95,'ativo',  38,''),
  ('CLI-4','Metalúrgica Bonfim Ltda.',       'privada',  '78.901.234/0001-23','São José do Rio Preto — SP','Cláudia Nunes',  'rh@bonfim.com.br',         '(17) 3333-0004',90,'ativo',  29,''),
  ('CLI-5','Município de Araraquara',        'municipio','46.634.101/0001-05','Araraquara — SP',         'Dr. Luiz Ferreira', 'proc@ararar.sp.gov.br',    '(16) 3333-0005',95,'atencao',22,'Pendências em aberto'),
  ('CLI-6','Ind. Campinas S/A',             'privada',  '34.567.890/0001-12','Campinas — SP',           'Marcos Vieira',     'juridico@indcamp.com.br',  '(19) 3333-0006',90,'atencao',18,'');

-- Demandas (datas relativas convertidas para fixas como exemplo)
INSERT INTO demandas (id, numero, processo, cliente_id, tipo, responsavel_id, prazo, prioridade, origem, status, obs, criado_em) VALUES
  ('DLS-101','DLS-2025-114','0001234-12.2025.8.26.0000','CLI-3','Cálculo Previdenciário','CALC-1', CURRENT_DATE+4,  'media',   'E-mail',             'triagem',   'Demanda de aposentadoria por invalidez.', NOW()-INTERVAL '1 day'),
  ('DLS-102','DLS-2025-113','0002345-45.2025.8.26.0000','CLI-2','Cálculo Trabalhista',   'CALC-2', CURRENT_DATE+10, 'baixa',   'E-mail',             'andamento', 'Rescisão contratual.',                   NOW()-INTERVAL '2 days'),
  ('DLS-103','DLS-2025-112','0003456-78.2025.8.26.0000','CLI-2','Cálculo Trabalhista',   NULL,     CURRENT_DATE,    'urgente', 'Sistema do cliente', 'pendente',  'Urgente — sem responsável.',             NOW()),
  ('DLS-104','DLS-2025-111','0004567-90.2025.8.26.0000','CLI-1','Liquidação de Sentença','CALC-3', CURRENT_DATE+14, 'media',   'E-mail',             'revisao',   '',                                       NOW()-INTERVAL '3 days'),
  ('DLS-105','DLS-2025-110','0005678-01.2025.8.26.0000','CLI-4','Atualização Monetária', 'CALC-2', CURRENT_DATE+1,  'alta',    'E-mail',             'andamento', '',                                       NOW()-INTERVAL '4 days'),
  ('DLS-106','DLS-2025-089','0006789-12.2025.8.26.0000','CLI-5','Liquidação de Sentença','CALC-4', CURRENT_DATE-2,  'urgente', 'E-mail',             'atrasada',  'VENCIDA',                                NOW()-INTERVAL '10 days'),
  ('DLS-107','DLS-2025-088','0007890-23.2025.8.26.0000','CLI-6','Cálculo Trabalhista',   'CALC-5', CURRENT_DATE-3,  'alta',    'Manual',             'atrasada',  'VENCIDA há 1 dia',                       NOW()-INTERVAL '12 days'),
  ('DLS-108','DLS-2025-103','0008901-34.2025.8.26.0000','CLI-1','Cálculo Tributário',    'CALC-3', CURRENT_DATE+20, 'baixa',   'Portal',             'andamento', '',                                       NOW()-INTERVAL '5 days'),
  ('DLS-109','DLS-2025-097','0009012-45.2025.8.26.0000','CLI-5','Cálculo Previdenciário','CALC-1', CURRENT_DATE,    'alta',    'E-mail',             'andamento', 'Prazo hoje.',                            NOW()-INTERVAL '7 days'),
  ('DLS-110','DLS-2025-095','0001122-55.2025.8.26.0000','CLI-4','Honorários Advocatícios','CALC-4',CURRENT_DATE+7,  'media',   'E-mail',             'pendente',  '',                                       NOW()-INTERVAL '3 days'),
  ('DLS-111','DLS-2025-080','0002233-66.2025.8.26.0000','CLI-1','Liquidação de Sentença','CALC-1', CURRENT_DATE-15, 'media',   'E-mail',             'entregue',  'Entregue no prazo.',                     NOW()-INTERVAL '25 days'),
  ('DLS-112','DLS-2025-075','0003344-77.2025.8.26.0000','CLI-2','Cálculo Trabalhista',   'CALC-2', CURRENT_DATE-20, 'media',   'E-mail',             'entregue',  '',                                       NOW()-INTERVAL '30 days');

-- Histórico inicial das demandas
INSERT INTO demanda_historico (demanda_id, texto, autor, data) VALUES
  ('DLS-101','Demanda criada e atribuída a Ana Luiza','admin',NOW()-INTERVAL '1 day'),
  ('DLS-102','Demanda criada','admin',NOW()-INTERVAL '2 days'),
  ('DLS-103','Demanda recebida via sistema. Sem responsável atribuído.','Sistema',NOW()),
  ('DLS-104','Demanda criada','admin',NOW()-INTERVAL '3 days'),
  ('DLS-105','Demanda criada','admin',NOW()-INTERVAL '4 days'),
  ('DLS-106','Prazo vencido — demanda marcada como atrasada','Sistema',NOW()-INTERVAL '1 day'),
  ('DLS-107','Prazo vencido','Sistema',NOW()-INTERVAL '2 days'),
  ('DLS-108','Demanda criada','admin',NOW()-INTERVAL '5 days'),
  ('DLS-109','Demanda criada','admin',NOW()-INTERVAL '7 days'),
  ('DLS-110','Demanda criada','admin',NOW()-INTERVAL '3 days'),
  ('DLS-111','Demanda entregue ao cliente','admin',NOW()-INTERVAL '14 days'),
  ('DLS-112','Demanda entregue','admin',NOW()-INTERVAL '19 days');

-- Log de auditoria inicial
INSERT INTO audit_logs (usuario, acao, entidade, detalhe) VALUES
  ('Sistema','Inicialização','Sistema','Banco de dados inicializado com dados de exemplo');


-- ============================================================
--  ROW LEVEL SECURITY (RLS) — base para autenticação Supabase
--  Descomente e adapte após configurar auth.users
-- ============================================================

-- ALTER TABLE calculistas    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE clientes        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE demandas        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE demanda_historico ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE demanda_comentarios ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE audit_logs      ENABLE ROW LEVEL SECURITY;

-- Exemplo: acesso total para usuários autenticados
-- CREATE POLICY "acesso_autenticado" ON demandas
--   FOR ALL USING (auth.role() = 'authenticated');


-- ============================================================
--  FIM DO SCHEMA
-- ============================================================
