# Customizações ARK ACADEMY (fork de thaleslaray/nossocrm)

Caderno de tudo que difere do upstream. Consultar ANTES de sincronizar o fork (Sync fork)
para re-aplicar/validar cada item após o merge da v2.

| # | Data | Mudança | Arquivos tocados | Motivo |
|---|------|---------|------------------|--------|
| 1 | 27/08/2026 | Cron `stage-evaluations` de `* * * * *` para `0 7 * * *` | `vercel.json` | Plano Hobby da Vercel só aceita cron diário |
| 2 | 27/08/2026 | Rebrand: "NossoCRM" -> "ARK ACADEMY" em textos de interface (41 arquivos) | `app/**`, `components/**`, `features/**`, `lib/**` (strings) | Marca própria |
| 3 | 27/08/2026 | Logo na sidebar: div "N" -> `<img src="/logo-arkacademy.jpg">` | `components/Layout.tsx`, `public/logo-arkacademy.jpg` | Marca própria |
| 4 | 27/08/2026 | Tema preto industrial + amarelo #FFD700 (paleta primary, tokens dark, contraste preto sobre amarelo) | `app/globals.css`, `tailwind.config.js` | Identidade visual |

## Planejado (ver docs privados em mau288/arkacademy-crm-docs)
- Provedor WhatsApp **uazapi** (`lib/messaging/providers/whatsapp/uazapi.provider.ts` + Factory + modal + edge function)
- Provedor Instagram **Zernio** (`zernio-instagram.provider.ts` + sync de histórico + webhook)

## Regras
- Provedores novos = arquivos novos (aditivo). Pontos de toque: Factory, ChannelSetupModal, rota de webhook.
- Atualização do upstream é sempre manual, em branch de teste, com preview na Vercel antes de ir para `main`.
- Nunca commitar credenciais: chaves ficam no Supabase (`organization_settings`) ou nas env vars da Vercel.
