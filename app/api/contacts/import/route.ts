import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { detectCsvDelimiter, parseCsv, type CsvDelimiter } from '@/lib/utils/csv';
import { normalizePhoneE164 } from '@/lib/phone';

export const maxDuration = 120;

const ImportModeSchema = z.enum(['create_only', 'upsert_by_email', 'skip_duplicates_by_email']);
type ImportMode = z.infer<typeof ImportModeSchema>;

const BooleanStringSchema = z
  .string()
  .optional()
  .transform(v => (v ?? '').toLowerCase())
  .transform(v => v === 'true' || v === '1' || v === 'yes' || v === 'on');

function normalizeHeader(h: string) {
  return (h || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

type ParsedRow = {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  role?: string;
  company?: string;
  status?: string;
  stage?: string;
  notes?: string;
};

const HEADER_SYNONYMS: Record<keyof ParsedRow, string[]> = {
  name: ['name', 'nome', 'nome completo', 'full name'],
  firstName: ['first name', 'firstname', 'primeiro nome', 'nome'],
  lastName: ['last name', 'lastname', 'sobrenome'],
  email: ['email', 'e-mail', 'e-mail address', 'mail'],
  phone: ['phone', 'telefone', 'celular', 'whatsapp', 'fone'],
  role: ['role', 'cargo', 'titulo', 'title', 'funcao', 'funçao', 'funcao/cargo'],
  company: ['company', 'empresa', 'conta', 'account', 'organization', 'organizacao', 'organização'],
  status: ['status'],
  stage: ['stage', 'etapa', 'lifecycle stage', 'ciclo de vida', 'pipeline stage'],
  notes: ['notes', 'nota', 'notas', 'observacoes', 'observações', 'obs'],
};

function buildHeaderIndex(headers: string[]) {
  const idx = new Map<string, number>();
  headers.forEach((h, i) => idx.set(normalizeHeader(h), i));

  const find = (syns: string[]) => {
    for (const s of syns) {
      const key = normalizeHeader(s);
      const found = idx.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const mapping: Record<keyof ParsedRow, number | undefined> = {
    name: find(HEADER_SYNONYMS.name),
    firstName: find(HEADER_SYNONYMS.firstName),
    lastName: find(HEADER_SYNONYMS.lastName),
    email: find(HEADER_SYNONYMS.email),
    phone: find(HEADER_SYNONYMS.phone),
    role: find(HEADER_SYNONYMS.role),
    company: find(HEADER_SYNONYMS.company),
    status: find(HEADER_SYNONYMS.status),
    stage: find(HEADER_SYNONYMS.stage),
    notes: find(HEADER_SYNONYMS.notes),
  };

  return mapping;
}

function getCell(row: string[], idx: number | undefined): string | undefined {
  if (idx === undefined) return undefined;
  const v = row[idx];
  const t = (v ?? '').trim();
  return t ? t : undefined;
}

/**
 * CSVs exportados por Excel no Windows são frequentemente Windows-1252, embora
 * venham sem metadado de charset. Decodificá-los sempre como UTF-8 transforma
 * acentos em "�" e grava o texto corrompido no CRM. Tentamos UTF-8 estrito
 * primeiro e usamos Windows-1252 apenas quando o arquivo não é UTF-8 válido.
 */
function decodeCsvFile(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function normalizeStatus(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = normalizeHeader(v).toUpperCase();
  if (s === 'ACTIVE' || s === 'ATIVO') return 'ACTIVE';
  if (s === 'INACTIVE' || s === 'INATIVO') return 'INACTIVE';
  if (s === 'CHURNED' || s === 'PERDIDO' || s === 'CANCELADO') return 'CHURNED';
  return undefined;
}

function normalizeStage(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = normalizeHeader(v).toUpperCase();
  if (s === 'LEAD') return 'LEAD';
  if (s === 'MQL') return 'MQL';
  if (s === 'PROSPECT' || s === 'OPORTUNIDADE') return 'PROSPECT';
  if (s === 'CUSTOMER' || s === 'CLIENTE') return 'CUSTOMER';
  if (s === 'OTHER' || s === 'OUTRO' || s === 'OUTROS') return 'OTHER';
  return undefined;
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const modeRaw = form.get('mode');
    const delimiterRaw = form.get('delimiter');
    const createCompanies = BooleanStringSchema.parse(String(form.get('createCompanies') ?? 'true'));
    const createDeals = BooleanStringSchema.parse(String(form.get('createDeals') ?? 'false'));
    const dealBoardId = String(form.get('dealBoardId') ?? '').trim();
    const dealStageId = String(form.get('dealStageId') ?? '').trim();

    const modeResult = ImportModeSchema.safeParse(String(modeRaw ?? 'upsert_by_email'));
    if (!modeResult.success) {
      return NextResponse.json({ error: 'Parâmetro mode inválido.' }, { status: 400 });
    }
    const mode: ImportMode = modeResult.data;

    if (createDeals && (!z.string().uuid().safeParse(dealBoardId).success || !z.string().uuid().safeParse(dealStageId).success)) {
      return NextResponse.json({ error: 'Pipeline e etapa inicial inválidos.' }, { status: 400 });
    }

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Arquivo CSV não enviado (field "file").' }, { status: 400 });
    }

    const text = decodeCsvFile(await file.arrayBuffer());
    const delimiter: CsvDelimiter =
      delimiterRaw === ',' || delimiterRaw === ';' || delimiterRaw === '\t'
        ? (delimiterRaw as CsvDelimiter)
        : detectCsvDelimiter(text);

    const { headers, rows } = parseCsv(text, delimiter);
    if (!headers.length) {
      return NextResponse.json({ error: 'CSV sem cabeçalho.' }, { status: 400 });
    }

    const mapping = buildHeaderIndex(headers);

    // Parse rows
    const parsed: Array<{ rowNumber: number; data: ParsedRow }> = [];
    const errors: Array<{ rowNumber: number; message: string }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const rowNumber = i + 2; // +1 header, +1 1-indexed

      const firstName = getCell(r, mapping.firstName);
      const lastName = getCell(r, mapping.lastName);
      const name = getCell(r, mapping.name);
      const email = getCell(r, mapping.email);
      const phone = getCell(r, mapping.phone);

      const computedName =
        (firstName || lastName)
          ? [firstName, lastName].filter(Boolean).join(' ').trim()
          : name;

      if (!computedName && !email) {
        errors.push({ rowNumber, message: 'Linha sem nome e sem email (não consigo criar contato).' });
        continue;
      }

      parsed.push({
        rowNumber,
        data: {
          name: computedName,
          email,
          phone,
          role: getCell(r, mapping.role),
          company: getCell(r, mapping.company),
          status: normalizeStatus(getCell(r, mapping.status)),
          stage: normalizeStage(getCell(r, mapping.stage)),
          notes: getCell(r, mapping.notes),
        },
      });
    }

    if (!parsed.length) {
      return NextResponse.json(
        {
          error: 'Nenhuma linha válida para importar.',
          errors,
        },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    // Auth check — must come before any data access
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.organization_id) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const orgId = profile.organization_id;

    // O destino do deal é sempre validado no servidor. Assim, um usuário não
    // consegue direcionar uma importação para um pipeline/etapa de outra organização.
    if (createDeals) {
      const { data: board, error: boardError } = await supabase
        .from('boards')
        .select('id')
        .eq('id', dealBoardId)
        .eq('organization_id', orgId)
        .is('deleted_at', null)
        .maybeSingle();
      if (boardError || !board) return NextResponse.json({ error: 'Pipeline não encontrado ou sem acesso.' }, { status: 403 });

      const { data: stage, error: stageError } = await supabase
        .from('board_stages')
        .select('id')
        .eq('id', dealStageId)
        .eq('board_id', dealBoardId)
        .maybeSingle();
      if (stageError || !stage) return NextResponse.json({ error: 'A etapa selecionada não pertence ao pipeline informado.' }, { status: 400 });
    }

    // Companies: preload and optionally create missing ones
    const { data: companies, error: companiesError } = await supabase
      .from('crm_companies')
      .select('id,name')
      .is('deleted_at', null);

    if (companiesError) {
      return NextResponse.json({ error: companiesError.message }, { status: 400 });
    }

    const companyIdByName = new Map<string, string>();
    for (const c of (companies || []) as Array<{ id: string; name: string }>) {
      if (c?.id && c?.name) companyIdByName.set(normalizeHeader(c.name), c.id);
    }

    const missingCompanies = new Set<string>();
    if (createCompanies) {
      for (const p of parsed) {
        const companyName = (p.data.company || '').trim();
        if (!companyName) continue;
        const key = normalizeHeader(companyName);
        if (!companyIdByName.has(key)) missingCompanies.add(companyName);
      }
    }

    if (createCompanies && missingCompanies.size) {
      const payload = Array.from(missingCompanies).map(name => ({ name, organization_id: orgId }));
      const { data: createdCompanies, error: createCompaniesError } = await supabase
        .from('crm_companies')
        .insert(payload)
        .select('id,name');

      if (createCompaniesError) {
        return NextResponse.json({ error: createCompaniesError.message }, { status: 400 });
      }
      for (const c of (createdCompanies || []) as Array<{ id: string; name: string }>) {
        if (c?.id && c?.name) companyIdByName.set(normalizeHeader(c.name), c.id);
      }
    }

    // Existing contacts by email (batch)
    const emails = Array.from(
      new Set(
        parsed
          .map(p => (p.data.email || '').trim().toLowerCase())
          .filter(Boolean)
      )
    );

    const contactIdsByEmail = new Map<string, string[]>();
    if (emails.length) {
      const chunkSize = 500;
      for (let i = 0; i < emails.length; i += chunkSize) {
        const chunk = emails.slice(i, i + chunkSize);
        const { data: existing, error: existingError } = await supabase
          .from('contacts')
          .select('id,email')
          .in('email', chunk)
          .is('deleted_at', null);

        if (existingError) {
          return NextResponse.json({ error: existingError.message }, { status: 400 });
        }
        for (const c of (existing || []) as Array<{ id: string; email: string | null }>) {
          const em = (c.email || '').toLowerCase().trim();
          if (!em) continue;
          const arr = contactIdsByEmail.get(em) || [];
          arr.push(c.id);
          contactIdsByEmail.set(em, arr);
        }
      }
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let dealsCreated = 0;
    const pendingDeals: Array<{ rowNumber: number; contactId: string; title: string; companyId: string | null }> = [];
    const queueDeal = (rowNumber: number, contactId: string, title: string, companyId: string | null) => {
      if (createDeals) pendingDeals.push({ rowNumber, contactId, title: title || 'Contato importado', companyId });
    };

    // Import in manageable chunks to reduce payload sizes
    const insertBatch: Array<{ rowNumber: number; payload: Record<string, unknown>; dealTitle: string; companyId: string | null }> = [];
    const flushInsert = async () => {
      if (!insertBatch.length) return;
      const batch = insertBatch.splice(0, insertBatch.length);
      const payloads = batch.map(i => i.payload);
      const { data: insertedContacts, error: insertError } = await supabase.from('contacts').insert(payloads).select('id');
      if (insertError) {
        // If batch insert fails, mark all rows as errors (keep it simple for v1)
        for (const item of batch) {
          errors.push({ rowNumber: item.rowNumber, message: insertError.message });
        }
      } else {
        created += insertedContacts?.length ?? 0;
        for (let index = 0; index < batch.length; index += 1) {
          const contact = insertedContacts?.[index];
          if (!contact?.id) {
            errors.push({ rowNumber: batch[index].rowNumber, message: 'Contato criado sem identificador retornado.' });
            continue;
          }
          queueDeal(batch[index].rowNumber, contact.id, batch[index].dealTitle, batch[index].companyId);
        }
      }
    };

    for (const p of parsed) {
      const rowNumber = p.rowNumber;
      const email = (p.data.email || '').trim().toLowerCase();
      const phoneE164 = p.data.phone ? normalizePhoneE164(p.data.phone) : undefined;
      const companyName = (p.data.company || '').trim();
      const companyId = companyName ? companyIdByName.get(normalizeHeader(companyName)) : undefined;

      const base = {
        name: p.data.name || '',
        email: p.data.email || null,
        phone: phoneE164 || null,
        role: p.data.role || null,
        client_company_id: companyId || null,
        notes: p.data.notes || null,
        status: p.data.status || 'ACTIVE',
        stage: p.data.stage || 'LEAD',
        organization_id: orgId,
        updated_at: new Date().toISOString(),
      };

      const existingIds = email ? (contactIdsByEmail.get(email) || []) : [];

      if (mode === 'create_only') {
        // Always create, even if duplicates exist.
        insertBatch.push({ rowNumber, payload: base, dealTitle: p.data.name || p.data.email || 'Contato importado', companyId: companyId || null });
        if (insertBatch.length >= 200) await flushInsert();
        continue;
      }

      if (mode === 'skip_duplicates_by_email' && existingIds.length > 0) {
        skipped += 1;
        continue;
      }

      if (mode === 'upsert_by_email' && existingIds.length > 0) {
        if (existingIds.length > 1) {
          errors.push({ rowNumber, message: `Email duplicado no CRM (${existingIds.length} registros). Importação ambígua.` });
          continue;
        }
        const id = existingIds[0];
        const { error: updateError } = await supabase
          .from('contacts')
          .update(base)
          .eq('id', id);

        if (updateError) {
          errors.push({ rowNumber, message: updateError.message });
        } else {
          updated += 1;
          queueDeal(rowNumber, id, p.data.name || p.data.email || 'Contato importado', companyId || null);
        }
        continue;
      }

      // No email match (or no email): create
      insertBatch.push({ rowNumber, payload: base, dealTitle: p.data.name || p.data.email || 'Contato importado', companyId: companyId || null });
      if (insertBatch.length >= 200) await flushInsert();
    }

    await flushInsert();

    if (createDeals && pendingDeals.length) {
      // Inserimos em blocos para manter a importação rápida também em listas grandes.
      const importedAt = new Date().toISOString();
      const dealChunkSize = 150;
      for (let start = 0; start < pendingDeals.length; start += dealChunkSize) {
        const chunk = pendingDeals.slice(start, start + dealChunkSize);
        const rowsToInsert = chunk.map(item => ({
          organization_id: orgId,
          owner_id: user.id,
          title: item.title,
          value: 0,
          probability: 0,
          priority: 'medium',
          status: dealStageId,
          board_id: dealBoardId,
          stage_id: dealStageId,
          contact_id: item.contactId,
          client_company_id: item.companyId,
          custom_fields: { import_source: 'contacts_csv' },
          is_won: false,
          is_lost: false,
          last_stage_change_date: importedAt,
        }));
        const { data: insertedDeals, error: dealsError } = await supabase.from('deals').insert(rowsToInsert).select('id');
        if (dealsError) {
          for (const item of chunk) errors.push({ rowNumber: item.rowNumber, message: `Não foi possível criar o negócio: ${dealsError.message}` });
        } else {
          dealsCreated += insertedDeals?.length ?? 0;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      delimiter,
      mode,
      totals: {
        rows: rows.length,
        parsed: parsed.length,
        created,
        updated,
        dealsCreated,
        skipped,
        errors: errors.length,
      },
      errors,
      detectedHeaders: headers,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error)?.message || 'Erro inesperado' },
      { status: 500 }
    );
  }
}

