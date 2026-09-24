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
  /** ARK: coluna opcional "tags" (separadas por virgula ou ;) */
  tags?: string[];
};

/** "a, b ; c" -> ["a","b","c"] sem repetidos, ate 40 chars cada */
function splitTags(v: string | undefined | null): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const raw of v.split(/[,;|]/)) {
    const t = raw.trim().slice(0, 40);
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

function unionTags(...lists: Array<string[] | null | undefined>): string[] {
  const out: string[] = [];
  for (const l of lists) for (const t of l || []) if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

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
  tags: ['tags', 'tag', 'etiquetas', 'etiqueta'],
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
    tags: find(HEADER_SYNONYMS.tags),
  };

  return mapping;
}

function getCell(row: string[], idx: number | undefined): string | undefined {
  if (idx === undefined) return undefined;
  const v = row[idx];
  const t = (v ?? '').trim();
  return t ? t : undefined;
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

    // ARK: tags para todos os importados + envio opcional para um funil (cria 1 negocio por contato)
    const globalTags = splitTags(String(form.get('tags') ?? ''));
    const boardIdRaw = String(form.get('boardId') ?? '').trim();
    const stageIdRaw = String(form.get('stageId') ?? '').trim();
    const uuid = z.string().uuid();
    const boardId = boardIdRaw && uuid.safeParse(boardIdRaw).success ? boardIdRaw : null;
    const stageId = stageIdRaw && uuid.safeParse(stageIdRaw).success ? stageIdRaw : null;
    if ((boardIdRaw || stageIdRaw) && !(boardId && stageId)) {
      return NextResponse.json({ error: 'Funil/etapa inválidos.' }, { status: 400 });
    }

    const modeResult = ImportModeSchema.safeParse(String(modeRaw ?? 'upsert_by_email'));
    if (!modeResult.success) {
      return NextResponse.json({ error: 'Parâmetro mode inválido.' }, { status: 400 });
    }
    const mode: ImportMode = modeResult.data;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Arquivo CSV não enviado (field "file").' }, { status: 400 });
    }

    const text = await file.text();
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
          tags: splitTags(getCell(r, mapping.tags)),
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

    if (boardId && stageId) {
      const { data: boardRow } = await supabase
        .from('boards').select('id').eq('id', boardId).eq('organization_id', orgId).is('deleted_at', null).maybeSingle();
      const { data: stageRow } = await supabase
        .from('board_stages').select('id').eq('id', stageId).eq('board_id', boardId).maybeSingle();
      if (!boardRow || !stageRow) {
        return NextResponse.json({ error: 'Funil ou etapa não encontrados nesta organização.' }, { status: 400 });
      }
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
    const existingTagsById = new Map<string, string[]>();
    if (emails.length) {
      const chunkSize = 500;
      for (let i = 0; i < emails.length; i += chunkSize) {
        const chunk = emails.slice(i, i + chunkSize);
        const { data: existing, error: existingError } = await supabase
          .from('contacts')
          .select('id,email,tags')
          .in('email', chunk)
          .is('deleted_at', null);

        if (existingError) {
          return NextResponse.json({ error: existingError.message }, { status: 400 });
        }
        for (const c of (existing || []) as Array<{ id: string; email: string | null; tags: string[] | null }>) {
          const em = (c.email || '').toLowerCase().trim();
          if (!em) continue;
          const arr = contactIdsByEmail.get(em) || [];
          arr.push(c.id);
          contactIdsByEmail.set(em, arr);
          existingTagsById.set(c.id, c.tags || []);
        }
      }
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Contatos que passaram pela importacao (criados ou atualizados) -> candidatos a negocio no funil
    const touched: Array<{ id: string; name: string; tags: string[] }> = [];

    // Import in manageable chunks to reduce payload sizes
    const insertBatch: Array<{ rowNumber: number; payload: Record<string, unknown> }> = [];
    const flushInsert = async () => {
      if (!insertBatch.length) return;
      const payloads = insertBatch.map(i => i.payload);
      const { data: insertedRows, error: insertError } = await supabase
        .from('contacts')
        .insert(payloads)
        .select('id,name,tags');
      if (insertError) {
        // If batch insert fails, mark all rows as errors (keep it simple for v1)
        for (const item of insertBatch) {
          errors.push({ rowNumber: item.rowNumber, message: insertError.message });
        }
      } else {
        created += insertBatch.length;
        for (const c of (insertedRows || []) as Array<{ id: string; name: string; tags: string[] | null }>) {
          touched.push({ id: c.id, name: c.name, tags: c.tags || [] });
        }
      }
      insertBatch.length = 0;
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
        tags: unionTags(globalTags, p.data.tags),
      };

      const existingIds = email ? (contactIdsByEmail.get(email) || []) : [];

      if (mode === 'create_only') {
        // Always create, even if duplicates exist.
        insertBatch.push({ rowNumber, payload: base });
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
        // tags: nunca apaga as que o contato ja tinha
        const mergedTags = unionTags(existingTagsById.get(id), globalTags, p.data.tags);
        const { error: updateError } = await supabase
          .from('contacts')
          .update({ ...base, tags: mergedTags })
          .eq('id', id);

        if (updateError) {
          errors.push({ rowNumber, message: updateError.message });
        } else {
          updated += 1;
          touched.push({ id, name: base.name, tags: mergedTags });
        }
        continue;
      }

      // No email match (or no email): create
      insertBatch.push({ rowNumber, payload: base });
      if (insertBatch.length >= 200) await flushInsert();
    }

    await flushInsert();

    // ARK: enviar para o funil — 1 negocio por contato importado, pulando quem ja tem
    // negocio aberto nesse funil. O dono do negocio vem do trigger (usuario logado).
    let dealsCreated = 0;
    let dealsSkipped = 0;
    if (boardId && stageId && touched.length) {
      const ids = touched.map(t => t.id);
      const hasOpen = new Set<string>();
      for (let i = 0; i < ids.length; i += 500) {
        const { data: openDeals } = await supabase
          .from('deals')
          .select('contact_id')
          .eq('board_id', boardId)
          .in('contact_id', ids.slice(i, i + 500))
          .eq('is_won', false)
          .eq('is_lost', false);
        for (const d of (openDeals || []) as Array<{ contact_id: string | null }>) if (d.contact_id) hasOpen.add(d.contact_id);
      }
      const seen = new Set<string>();
      const dealRows = touched
        .filter(t => !seen.has(t.id) && seen.add(t.id))
        .filter(t => !hasOpen.has(t.id))
        .map(t => ({
          organization_id: orgId,
          board_id: boardId,
          stage_id: stageId,
          status: stageId,
          title: t.name || 'Contato importado',
          value: 0,
          probability: 0,
          priority: 'medium',
          contact_id: t.id,
          tags: t.tags,
          custom_fields: {},
          is_won: false,
          is_lost: false,
        }));
      dealsSkipped = touched.length - dealRows.length;
      for (let i = 0; i < dealRows.length; i += 100) {
        const chunk = dealRows.slice(i, i + 100);
        const { error: dealErr } = await supabase.from('deals').insert(chunk);
        if (!dealErr) { dealsCreated += chunk.length; continue; }
        // lote falhou (ex.: trigger de duplicidade) -> tenta um a um para nao perder o lote inteiro
        for (const row of chunk) {
          const { error: oneErr } = await supabase.from('deals').insert(row);
          if (oneErr) errors.push({ rowNumber: 0, message: `Negócio não criado para "${row.title}": ${oneErr.message}` });
          else dealsCreated += 1;
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
        skipped,
        errors: errors.length,
        dealsCreated,
        dealsSkipped,
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

