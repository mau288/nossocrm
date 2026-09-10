# Customizações ARK ACADEMY (fork de thaleslaray/nossocrm)

Caderno de tudo que difere do upstream. Consultar ANTES de sincronizar o fork (Sync fork)
para re-aplicar/validar cada item após o merge da v2.

| # | Data | Mudança | Arquivos tocados | Motivo |
|---|------|---------|------------------|--------|
| 1 | 27/08/2026 | Cron `stage-evaluations` de `* * * * *` para `0 7 * * *` | `vercel.json` | Plano Hobby da Vercel só aceita cron diário |
| 2 | 27/08/2026 | Rebrand: "NossoCRM" -> "ARK ACADEMY" em textos de interface (41 arquivos) | `app/**`, `components/**`, `features/**`, `lib/**` (strings) | Marca própria |
| 3 | 27/08/2026 | Logo na sidebar: div "N" -> `<img src="/logo-arkacademy.jpg">` | `components/Layout.tsx`, `public/logo-arkacademy.jpg` | Marca própria |
| 4 | 27/08/2026 | Tema preto industrial + amarelo #FFD700 (paleta primary, tokens dark, contraste preto sobre amarelo) | `app/globals.css`, `tailwind.config.js` | Identidade visual |
| 5 | 31/08/2026 | Provedor Instagram **Zernio** + edge function do webhook (v1.2) | `lib/messaging/providers/instagram/zernio.provider.ts`, Factory, `ChannelSetupModal`, `supabase/functions/messaging-webhook-zernio/` | Atender o Direct pelo CRM |
| 6 | 31/08/2026 | **FIX do envio preso em `queued`**: `void (async…)()` -> `after()` do next/server | `app/api/messaging/messages/route.ts` | Na Vercel a invocação congela após a resposta e a mensagem nunca sai. **Bug existe no upstream** |
| 7 | 01/09/2026 | Tags livres + follow-up programado (robô pg_cron) | `supabase/migrations/20260901000000_contact_tags_scheduled_messages.sql`, `supabase/functions/scheduled-messages-dispatch/`, `ContactTagsSection.tsx`, `ScheduledMessagesSection.tsx` | Rastro do lead entre funis e agendamento de mensagem |
| 8 | 01/09/2026 | "Enviar pro Funil" (deal criado só por decisão do operador, com tags) | `features/messaging/components/Modals/SendToFunnelModal.tsx` | Nem toda conversa deve virar card |
| 9 | 01/09/2026 | "Puxar pro WhatsApp" (handoff IG -> chip, com mesclagem de contato) | `features/messaging/components/Modals/PullToWhatsAppModal.tsx`, `ContactPanel.tsx` | Continuar no WhatsApp quando o lead passa o telefone |
| 10 | 01/09/2026 | `webhook-in` aceita `tags` (array ou CSV) e acumula no contato | `supabase/functions/webhook-in/index.ts` | n8n manda o funil de origem junto com o lead |
| 11 | 01/09/2026 | Funis em pirâmide colorida por etapa, filtráveis por tag, no fim da Visão Geral | `features/dashboard/components/FunnelOverview.tsx` | Monitorar leads por produto/fase |
| 12 | 01/09/2026 | **Instalador aplica TODAS as migrations**, não só o snapshot (+ livro-caixa `_installer_migrations`) e 3 migrations corrigidas | `lib/installer/migrations.ts`, `20260223000002_*`, `20260224000000_*`, `20260409120000_*` | Sem isso a instalação nasce em *schema drift* e a Central de I.A. responde 500. **Vale como PR pro upstream** |

## Planejado (ver docs privados em mau288/arkacademy-crm-docs)
- Provedor WhatsApp **uazapi** (`lib/messaging/providers/whatsapp/uazapi.provider.ts` + Factory + modal + edge function)
- Carga inicial do histórico do Direct (Zernio) — hoje só entra mensagem nova
- Abrir PR no upstream com os itens 6 e 12

## Regras
- Provedores novos = arquivos novos (aditivo). Pontos de toque: Factory, ChannelSetupModal, rota de webhook.
- Atualização do upstream é sempre manual, em branch de teste, com preview na Vercel antes de ir para `main`.
- Nunca commitar credenciais: chaves ficam no Supabase (`organization_settings`) ou nas env vars da Vercel.
- O instalador NÃO cria dados (funis, etapas, produtos, canais): isso é conteúdo do banco, não código.
