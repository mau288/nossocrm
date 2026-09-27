# Ponto de restauracao — 26/09/2026

Retrato do CRM ArkAcademy ANTES do pacote de mensagens (video, colar imagem, reacoes, edicao, figurinha/GIF).
Esta branch NAO e para merge: e so arquivo. Nada aqui e publicado.

## Estado de producao neste momento
| Camada | Versao | Onde esta o fonte |
|---|---|---|
| App (Vercel, crm-arkacademy.vercel.app) | `main` = `239d19d` = tag `v1.8-comentarios` / `v1.8.1-base` | main |
| Deploy Vercel em producao | `dpl_9jk7JAnBXHrmM9StvWZocg7RSGZD` (24/09 20:12) | voltar = Promote desse deploy |
| messaging-webhook-evolution | v6 (23/09 17:12) | igual ao main |
| messaging-webhook-zernio | v10 (17/09 12:50) | **NAO e o do main**: e o do snapshot `40b7ae4` (branch fix/zernio-mensagens-bot) |
| webhook-in | v5 (01/09) | igual ao main |
| scheduled-messages-dispatch | v2 (31/08) | igual ao main |
| messaging-webhook-meta / zapi / resend | v4 (27/08) | igual ao main |
| Banco (Supabase vzqwkckbkwtrowyykmmf) | sem backup automatico (0 backups, sem PITR) | export logico local, fora do Git |

## Atencao
- Publicar `messaging-webhook-zernio` a partir do `main` REGRIDE a funcao (perde historico do Direct,
  sincronizacao de lacunas, anexos e vinculo do YouTube). Antes de publicar, trazer o fonte do snapshot para o main.
- `functions/` desta pasta foi baixado do Supabase em 26/09 (`supabase functions download --use-api`)
  e conferido por hash contra o Git.

## Como voltar
- App: Vercel > Deployments > deploy acima > Promote to Production (sem rebuild).
- Funcao: `git checkout v1.8.1-base` (ou esta pasta) e `supabase functions deploy <slug> --no-verify-jwt --use-api`.
- Dados: reimportar do export local em `07-escola-automacao-ia/backups-crm/2026-09-26/`.
