<?php
declare(strict_types=1);

require_once __DIR__ . '/dls_database.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

try {
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $action = $_GET['action'] ?? '';
        $resource = $_GET['resource'] ?? '';

        if ($action === 'status') {
            dls_respond([
                'ok' => true,
                'data' => dls_config_status(),
            ]);
        }

        $db = dls_db();

        if ($action === 'bootstrap') {
            dls_respond([
                'ok' => true,
                'data' => dls_bootstrap($db),
            ]);
        }

        dls_respond([
            'ok' => true,
            'data' => dls_resource($db, $resource),
        ]);
    }

    $db = dls_db();

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        dls_respond(['ok' => false, 'error' => 'Metodo nao permitido.'], 405);
    }

    $payload = dls_payload();
    $action = (string)($payload['action'] ?? '');

    if ($action === 'set') {
        $key = (string)($payload['key'] ?? '');
        $value = $payload['value'] ?? [];
        dls_replace_key($db, $key, $value);
        dls_respond(['ok' => true, 'data' => dls_key_data($db, $key)]);
    }

    if ($action === 'nextId') {
        dls_respond(['ok' => true, 'seq' => dls_next_id($db)]);
    }

    if ($action === 'log') {
        dls_insert_log(
            $db,
            (string)($payload['usuario'] ?? 'admin'),
            (string)($payload['acao'] ?? ''),
            (string)($payload['entidade'] ?? ''),
            (string)($payload['detalhe'] ?? '')
        );
        dls_respond(['ok' => true, 'data' => dls_logs($db)]);
    }

    dls_respond(['ok' => false, 'error' => 'Acao invalida.'], 400);
} catch (Throwable $e) {
    dls_respond(['ok' => false, 'error' => $e->getMessage()], 500);
}

function dls_respond(array $data, int $status = 200): void
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function dls_payload(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: '[]', true);
    return is_array($data) ? $data : [];
}

function dls_config_status(): array
{
    $config = dls_supabase_config();
    $url = trim((string)($config['url'] ?? ''));
    $key = trim((string)($config['service_role_key'] ?? ''));

    return [
        'configured' => $url !== '' && $key !== '',
        'hasUrl' => $url !== '',
        'hasServiceRoleKey' => $key !== '',
        'schema' => (string)($config['schema'] ?? 'public'),
        'configFile' => is_file(__DIR__ . '/dls_supabase.local.php') ? 'dls_supabase.local.php' : null,
    ];
}

function dls_bootstrap(DlsSupabaseClient $db): array
{
    return [
        'dls_demandas' => dls_demandas($db),
        'dls_calculistas' => dls_calculistas($db),
        'dls_clientes' => dls_clientes($db),
        'dls_logs' => dls_logs($db),
        'dls_seq' => (string)dls_current_sequence($db),
    ];
}

function dls_resource(DlsSupabaseClient $db, string $resource): array
{
    return match ($resource) {
        'demandas' => dls_demandas($db),
        'calculistas' => dls_calculistas($db),
        'clientes' => dls_clientes($db),
        'logs' => dls_logs($db),
        default => dls_bootstrap($db),
    };
}

function dls_key_data(DlsSupabaseClient $db, string $key): mixed
{
    return match ($key) {
        'dls_demandas' => dls_demandas($db),
        'dls_calculistas' => dls_calculistas($db),
        'dls_clientes' => dls_clientes($db),
        'dls_logs' => dls_logs($db),
        'dls_seq' => (string)dls_current_sequence($db),
        default => [],
    };
}

function dls_replace_key(DlsSupabaseClient $db, string $key, mixed $value): void
{
    if ($key === 'dls_seq') {
        dls_set_sequence($db, (int)$value);
        return;
    }

    if (!is_array($value)) {
        $value = [];
    }

    match ($key) {
        'dls_demandas' => dls_replace_demandas($db, $value),
        'dls_calculistas' => dls_replace_calculistas($db, $value),
        'dls_clientes' => dls_replace_clientes($db, $value),
        'dls_logs' => dls_replace_logs($db, $value),
        default => throw new InvalidArgumentException('Chave de dados invalida.'),
    };
}

function dls_current_sequence(DlsSupabaseClient $db): int
{
    $rows = $db->select('dls_sequences', [
        'select' => 'current_value',
        'name' => 'eq.main',
        'limit' => '1',
    ]);

    if ($rows === []) {
        $db->insert('dls_sequences', [['name' => 'main', 'current_value' => 100]]);
        return 100;
    }

    return (int)($rows[0]['current_value'] ?? 100);
}

function dls_set_sequence(DlsSupabaseClient $db, int $value): void
{
    $db->upsert('dls_sequences', [[
        'name' => 'main',
        'current_value' => $value,
    ]], 'name');
}

function dls_next_id(DlsSupabaseClient $db): int
{
    $result = $db->rpc('dls_next_sequence', [
        'sequence_name' => 'main',
        'default_value' => 100,
    ]);

    if (is_numeric($result)) {
        return (int)$result;
    }

    if (is_array($result)) {
        if (isset($result[0]) && is_numeric($result[0])) {
            return (int)$result[0];
        }

        if (isset($result[0]['dls_next_sequence']) && is_numeric($result[0]['dls_next_sequence'])) {
            return (int)$result[0]['dls_next_sequence'];
        }
    }

    throw new RuntimeException('Funcao dls_next_sequence nao retornou um numero. Rode o schema Supabase atualizado.');
}

function dls_calculistas(DlsSupabaseClient $db): array
{
    $rows = $db->select('dls_calculistas', ['order' => 'nome.asc']);

    return array_map(static fn(array $row): array => [
        'id' => (string)$row['id'],
        'nome' => (string)$row['nome'],
        'cargo' => (string)$row['cargo'],
        'email' => (string)$row['email'],
        'tel' => (string)($row['tel'] ?? ''),
        'espec' => (string)($row['espec'] ?? 'Geral'),
        'status' => (string)$row['status'],
        'meta' => (int)$row['meta'],
        'concluidas' => (int)$row['concluidas'],
        'sla' => (float)$row['sla'],
        'ativas' => (int)$row['ativas'],
        'tempoMedio' => (float)$row['tempo_medio'],
        'obs' => (string)($row['obs'] ?? ''),
    ], $rows);
}

function dls_clientes(DlsSupabaseClient $db): array
{
    $rows = $db->select('dls_clientes', ['order' => 'nome.asc']);

    return array_map(static fn(array $row): array => [
        'id' => (string)$row['id'],
        'nome' => (string)$row['nome'],
        'tipo' => (string)$row['tipo'],
        'cnpj' => (string)($row['cnpj'] ?? ''),
        'cidade' => (string)($row['cidade'] ?? ''),
        'contato' => (string)($row['contato'] ?? ''),
        'email' => (string)($row['email'] ?? ''),
        'tel' => (string)($row['tel'] ?? ''),
        'slaContratado' => (int)$row['sla_contratado'],
        'statusRel' => (string)$row['status_rel'],
        'totalHistorico' => (int)$row['total_historico'],
        'obs' => (string)($row['obs'] ?? ''),
    ], $rows);
}

function dls_demandas(DlsSupabaseClient $db): array
{
    $rows = $db->select('dls_demandas', ['order' => 'criado_em.desc.nullslast,numero.desc']);

    return array_map(static fn(array $row): array => [
        'id' => (string)$row['id'],
        'numero' => (string)$row['numero'],
        'processo' => (string)($row['processo'] ?? ''),
        'dataRequisicao' => (string)($row['data_requisicao'] ?? ''),
        'reclamante' => (string)($row['reclamante'] ?? ''),
        'clienteId' => (string)($row['cliente_id'] ?? ''),
        'tipo' => (string)$row['tipo'],
        'responsavelId' => (string)($row['responsavel_id'] ?? ''),
        'prazo' => (string)($row['prazo'] ?? ''),
        'prioridade' => (string)$row['prioridade'],
        'origem' => (string)($row['origem'] ?? ''),
        'status' => (string)$row['status'],
        'obs' => (string)($row['obs'] ?? ''),
        'criadoEm' => dls_datetime_out($row['criado_em'] ?? null),
        'updatedAt' => dls_datetime_out($row['updated_at'] ?? null),
        'historico' => dls_json_array($row['historico'] ?? null),
        'comentarios' => dls_json_array($row['comentarios'] ?? null),
    ], $rows);
}

function dls_logs(DlsSupabaseClient $db): array
{
    $rows = $db->select('dls_logs', [
        'order' => 'id.desc',
        'limit' => '200',
    ]);

    return array_map(static fn(array $row): array => [
        'id' => (int)$row['id'],
        'data' => (string)$row['data_label'],
        'usuario' => (string)$row['usuario'],
        'acao' => (string)$row['acao'],
        'entidade' => (string)$row['entidade'],
        'detalhe' => (string)($row['detalhe'] ?? ''),
    ], $rows);
}

function dls_replace_calculistas(DlsSupabaseClient $db, array $items): void
{
    $rows = [];

    foreach ($items as $item) {
        if (!is_array($item) || empty($item['id']) || empty($item['nome'])) {
            continue;
        }

        $rows[] = [
            'id' => (string)$item['id'],
            'nome' => (string)$item['nome'],
            'cargo' => (string)($item['cargo'] ?? 'Calculista Pleno'),
            'email' => (string)($item['email'] ?? ''),
            'tel' => dls_empty_to_null($item['tel'] ?? null),
            'espec' => dls_empty_to_null($item['espec'] ?? 'Geral'),
            'status' => (string)($item['status'] ?? 'online'),
            'meta' => (int)($item['meta'] ?? 20),
            'concluidas' => (int)($item['concluidas'] ?? 0),
            'sla' => (float)($item['sla'] ?? 95),
            'ativas' => (int)($item['ativas'] ?? 0),
            'tempo_medio' => (float)($item['tempoMedio'] ?? 2.0),
            'obs' => dls_empty_to_null($item['obs'] ?? null),
        ];
    }

    $db->replaceAll('dls_calculistas', $rows);
}

function dls_replace_clientes(DlsSupabaseClient $db, array $items): void
{
    $rows = [];

    foreach ($items as $item) {
        if (!is_array($item) || empty($item['id']) || empty($item['nome'])) {
            continue;
        }

        $rows[] = [
            'id' => (string)$item['id'],
            'nome' => (string)$item['nome'],
            'tipo' => (string)($item['tipo'] ?? 'privada'),
            'cnpj' => dls_empty_to_null($item['cnpj'] ?? null),
            'cidade' => dls_empty_to_null($item['cidade'] ?? null),
            'contato' => dls_empty_to_null($item['contato'] ?? null),
            'email' => dls_empty_to_null($item['email'] ?? null),
            'tel' => dls_empty_to_null($item['tel'] ?? null),
            'sla_contratado' => (int)($item['slaContratado'] ?? 95),
            'status_rel' => (string)($item['statusRel'] ?? 'ativo'),
            'total_historico' => (int)($item['totalHistorico'] ?? 0),
            'obs' => dls_empty_to_null($item['obs'] ?? null),
        ];
    }

    $db->replaceAll('dls_clientes', $rows);
}

function dls_replace_demandas(DlsSupabaseClient $db, array $items): void
{
    $rows = [];

    foreach ($items as $item) {
        if (!is_array($item) || empty($item['id']) || empty($item['numero'])) {
            continue;
        }

        $rows[] = [
            'id' => (string)$item['id'],
            'numero' => (string)$item['numero'],
            'processo' => dls_empty_to_null($item['processo'] ?? null),
            'data_requisicao' => dls_date_in($item['dataRequisicao'] ?? null),
            'reclamante' => dls_empty_to_null($item['reclamante'] ?? null),
            'cliente_id' => dls_empty_to_null($item['clienteId'] ?? null),
            'tipo' => (string)($item['tipo'] ?? 'Calculo'),
            'responsavel_id' => dls_empty_to_null($item['responsavelId'] ?? null),
            'prazo' => dls_date_in($item['prazo'] ?? null),
            'prioridade' => (string)($item['prioridade'] ?? 'media'),
            'origem' => dls_empty_to_null($item['origem'] ?? null),
            'status' => (string)($item['status'] ?? 'triagem'),
            'obs' => dls_empty_to_null($item['obs'] ?? null),
            'criado_em' => dls_datetime_in($item['criadoEm'] ?? null),
            'updated_at' => dls_datetime_in($item['updatedAt'] ?? null),
            'historico' => dls_json_value($item['historico'] ?? []),
            'comentarios' => dls_json_value($item['comentarios'] ?? []),
        ];
    }

    $db->replaceAll('dls_demandas', $rows);
}

function dls_replace_logs(DlsSupabaseClient $db, array $items): void
{
    $rows = [];

    foreach (array_slice($items, 0, 200) as $item) {
        if (!is_array($item)) {
            continue;
        }

        $rows[] = [
            'id' => (int)($item['id'] ?? dls_log_id()),
            'data_label' => (string)($item['data'] ?? date('d/m/Y H:i:s')),
            'usuario' => (string)($item['usuario'] ?? 'admin'),
            'acao' => (string)($item['acao'] ?? ''),
            'entidade' => (string)($item['entidade'] ?? ''),
            'detalhe' => dls_empty_to_null($item['detalhe'] ?? null),
            'logged_at' => date('c'),
        ];
    }

    $db->replaceAll('dls_logs', $rows);
}

function dls_insert_log(DlsSupabaseClient $db, string $usuario, string $acao, string $entidade, string $detalhe): void
{
    $db->insert('dls_logs', [[
        'id' => dls_log_id(),
        'data_label' => date('d/m/Y H:i:s'),
        'usuario' => $usuario,
        'acao' => $acao,
        'entidade' => $entidade,
        'detalhe' => dls_empty_to_null($detalhe),
    ]]);

    dls_trim_logs($db);
}

function dls_trim_logs(DlsSupabaseClient $db): void
{
    $rows = $db->select('dls_logs', [
        'select' => 'id',
        'order' => 'id.desc',
        'offset' => '200',
    ]);

    if ($rows === []) {
        return;
    }

    $ids = [];

    foreach ($rows as $row) {
        if (isset($row['id']) && is_numeric($row['id'])) {
            $ids[] = (string)(int)$row['id'];
        }
    }

    foreach (array_chunk($ids, 100) as $chunk) {
        if ($chunk !== []) {
            $db->deleteWhere('dls_logs', ['id' => 'in.(' . implode(',', $chunk) . ')']);
        }
    }
}

function dls_log_id(): int
{
    return (int)round(microtime(true) * 1000000);
}

function dls_empty_to_null(mixed $value): ?string
{
    if ($value === null) {
        return null;
    }

    $value = trim((string)$value);
    return $value === '' ? null : $value;
}

function dls_date_in(mixed $value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }

    $time = strtotime((string)$value);
    return $time === false ? null : date('Y-m-d', $time);
}

function dls_json_array(mixed $value): array
{
    if (is_array($value)) {
        return $value;
    }

    if ($value === null || $value === '') {
        return [];
    }

    $decoded = json_decode((string)$value, true);
    return is_array($decoded) ? $decoded : [];
}

function dls_json_value(mixed $value): array
{
    return is_array($value) ? $value : dls_json_array($value);
}

function dls_datetime_in(mixed $value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }

    $time = strtotime((string)$value);
    return $time === false ? null : date('Y-m-d H:i:s', $time);
}

function dls_datetime_out(mixed $value): string
{
    if ($value === null || $value === '') {
        return '';
    }

    $time = strtotime((string)$value);
    return $time === false ? '' : date('Y-m-d\TH:i:s', $time);
}
