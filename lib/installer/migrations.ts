import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

/**
 * Livro-caixa das migrations. Guarda o nome de cada arquivo já aplicado, para
 * que reinstalar/retomar não tente rodar tudo de novo.
 */
const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS public._installer_migrations (
    name        text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

/** Migrations em ordem cronológica (o nome do arquivo começa com o timestamp). */
function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function needsSsl(connectionString: string) {
  return !/sslmode=disable/i.test(connectionString);
}

function stripSslModeParam(connectionString: string) {
  // Some drivers/envs treat `sslmode=require` inconsistently. We control SSL via `Client({ ssl })`.
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return connectionString;
  }
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function isRetryableConnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('ENOTFOUND') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('timeout')
  );
}

/**
 * Conecta com retry/backoff, recriando o Client a cada tentativa.
 * Isso evita o erro: "Client has already been connected. You cannot reuse a client."
 */
async function connectClientWithRetry(
  createClient: () => Client,
  opts?: { maxAttempts?: number; initialDelayMs?: number }
): Promise<Client> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  const initialDelayMs = opts?.initialDelayMs ?? 3000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = createClient();
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      try {
        await client.end().catch(() => undefined);
      } catch {
        // ignore
      }

      if (!isRetryableConnectError(err) || attempt === maxAttempts) {
        throw err;
      }

      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[migrations] Conexão falhou (${msg}), tentativa ${attempt}/${maxAttempts}. Aguardando ${Math.round(
          delayMs / 1000
        )}s...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Falha ao conectar ao banco de dados'));
}

async function waitForStorageReady(client: Client, opts?: { timeoutMs?: number; pollMs?: number }) {
  const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 210_000;
  const pollMs = typeof opts?.pollMs === 'number' ? opts?.pollMs : 4_000;
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await client.query<{ ready: boolean }>(
        `select (to_regclass('storage.buckets') is not null) as ready`
      );
      const ready = Boolean(r?.rows?.[0]?.ready);
      if (ready) return;
    } catch {
      // keep polling on transient errors
    }
    await sleep(pollMs);
  }

  throw new Error(
    'Supabase Storage ainda não está pronto (storage.buckets não existe). Aguarde o projeto terminar de provisionar e tente novamente.'
  );
}

/**
 * Função pública `runSchemaMigration` do projeto.
 */
export async function runSchemaMigration(dbUrl: string) {
  const files = listMigrationFiles();
  if (files.length === 0) {
    throw new Error(`Nenhuma migration encontrada em ${MIGRATIONS_DIR}.`);
  }
  const normalizedDbUrl = stripSslModeParam(dbUrl);

  const createClient = () =>
    new Client({
      connectionString: normalizedDbUrl,
      // NOTE: Supabase DB uses TLS; on some networks a MITM/corporate proxy can inject a cert chain
      // that Node doesn't trust. For the installer/migrations step we prefer "no-verify" over failure.
      ssl: needsSsl(dbUrl) ? { rejectUnauthorized: false } : undefined,
    });

  const client = await connectClientWithRetry(createClient, { maxAttempts: 5, initialDelayMs: 3000 });

  try {
    // Never "skip" Storage. We wait until it's ready, then run migrations.
    await waitForStorageReady(client);

    // O snapshot inicial monta o schema; as migrations seguintes trazem tudo o
    // que veio depois (messaging, board_ai_config, HITL, ai_paused...). Aplicar
    // só o snapshot deixa o banco em "schema drift": o app sobe, mas rotas como
    // GET /api/settings/ai respondem 500 porque as colunas não existem.
    await client.query(LEDGER_DDL);
    const applied = await client.query<{ name: string }>(
      'SELECT name FROM public._installer_migrations'
    );
    const done = new Set(applied.rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Uma transação por arquivo: ou a migration entra inteira, ou não entra —
      // e o livro-caixa nunca marca como feita uma migration que falhou.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO public._installer_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrations] ${file} aplicada.`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Falha na migration ${file}: ${msg}`);
      }
    }

    // Sem isso o PostgREST continua servindo o schema antigo em cache e o app
    // reclama de colunas que já existem no banco.
    await client.query(`NOTIFY pgrst, 'reload schema'`).catch(() => undefined);
  } finally {
    await client.end();
  }
}
