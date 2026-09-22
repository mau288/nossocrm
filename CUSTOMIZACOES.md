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
| 13 | 22/09/2026 | **Etapa de ganho/perda declarada nos 3 funis** + "Matriculado" padronizado + "No-show" na Consultiva | `supabase/migrations/20260922200000_funis_ganho_visibilidade.sql` | Os boards nasceram sem `won_stage_id`/`lost_stage_id`, entao o botao GANHO caia no fallback: marcava `is_won` e **nao movia o card** |
| 14 | 22/09/2026 | "Em Aberto" mostra fechado recente; periodo escolhido desliga a janela de 30 dias; "Todos" deixa de aplicar janela | `features/boards/hooks/useBoardsController.ts` | O ramo `open` descartava o ganho antes do `matchesRecent` ter efeito e o card sumia da tela ao ser ganho. **Bug existe no upstream** |
| 15 | 22/09/2026 | Filtro de periodo exposto no header do board, com `closed_at` para card fechado e `created_at` para aberto | `features/boards/components/Kanban/KanbanHeader.tsx`, `PipelineView.tsx` | O `dateRange` ja existia no controller e nao tinha controle na UI; filtrar por `created_at` enganaria o relatorio mensal |
| 16 | 22/09/2026 | Lapis no campo de valor do negocio, igual ao do titulo | `features/boards/components/Modals/DealDetailModal.tsx` | O valor so editava clicando no numero, sem afordancia |
| 17 | 22/09/2026 | `sw.js` e `manifest.json` fora do proxy de autenticacao | `proxy.ts` | Os dois caiam no matcher e viravam 307 para `/login` sem sessao. O browser recusa redirect em script de service worker, entao o SW nao conseguia se atualizar e seguia servindo o shell em cache: depois de cada deploy o app aparecia quebrado. O manifest do PWA quebrava pelo mesmo motivo. **Bug existe no upstream** |
| 18 | 22/09/2026 | **Gateways de pagamento com taxa por forma de pagamento** (`gateways` + `gateway_fees`) e imposto padrao da organizacao | `supabase/migrations/20260922230000_financeiro_gateways_taxas.sql`, `lib/supabase/gateways.ts`, `lib/query/hooks/useGatewaysQuery.ts` | A taxa e do GATEWAY, nunca do produto — o mesmo produto vende por gateways diferentes — e muda tambem por forma de pagamento (boleto/PIX x cartao parcelado) |
| 19 | 22/09/2026 | Configuracoes ganha a aba **Financeiro**: cadastro de gateways, taxa por forma e imposto padrao | `features/settings/components/GatewaysManager.tsx`, `features/settings/SettingsPage.tsx`, `app/(protected)/settings/financeiro/page.tsx` | Sem cadastro na tela, as taxas so entrariam por SQL |
| 20 | 22/09/2026 | Bloco financeiro no card do negocio: gateway, forma, taxa e imposto editaveis, com o liquido calculado na hora | `features/boards/components/Modals/DealFinanceiroSection.tsx` | Escolher o gateway preenche a taxa e ela fica editavel ali mesmo, porque a venda as vezes foge do padrao |
| 21 | 22/09/2026 | Visao Geral: **Realizado** e **Previsao** em blocos separados, cada um com faturamento / apos taxas / apos taxas + imposto | `features/dashboard/components/ResultadoFinanceiroSection.tsx`, `DashboardPage.tsx` | Somar realizado com previsao daria um numero que nao existe. A formula mora so em `lib/financeiro/calculo.ts` |
| 22 | 22/09/2026 | `gatewaysService` re-exportado em `lib/supabase.ts` | `lib/supabase.ts` | `@/lib/supabase` resolve para o ARQUIVO `lib/supabase.ts`, nao para `lib/supabase/index.ts`. O projeto mantem os dois barris e servico novo precisa entrar nos dois |

## Planejado (ver docs privados em mau288/arkacademy-crm-docs)
- Provedor WhatsApp **uazapi** (`lib/messaging/providers/whatsapp/uazapi.provider.ts` + Factory + modal + edge function)
- Carga inicial do histórico do Direct (Zernio) — hoje só entra mensagem nova
- Abrir PR no upstream com os itens 6 e 12

## Regras
- Provedores novos = arquivos novos (aditivo). Pontos de toque: Factory, ChannelSetupModal, rota de webhook.
- Atualização do upstream é sempre manual, em branch de teste, com preview na Vercel antes de ir para `main`.
- Nunca commitar credenciais: chaves ficam no Supabase (`organization_settings`) ou nas env vars da Vercel.
- O instalador NÃO cria dados (funis, etapas, produtos, canais): isso é conteúdo do banco, não código.
