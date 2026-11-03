# Estado do CRM ARK ACADEMY — revisão de 03/11/2026

Fotografia de como o CRM está hoje: o que roda, o que ele faz, o que aconteceu nos últimos dias e o que falta.
Documento vivo: atualizar a cada versão. O detalhe item a item fica em `CUSTOMIZACOES.md` (62 itens).

Versão em produção: **v1.19.5** (tag `v1.19.5-evolution-reconexao`, main `1d5437f`).

---

## 1. O que é e onde roda

| Peça | Onde | Observação |
|---|---|---|
| Aplicação (Next.js 16 / React 19) | Vercel, projeto `nossocrm` → **crm.arkacademy.com.br** | Deploy automático a cada push na `main`; preview por branch atrás de SSO |
| Banco, autenticação, storage, cron | Supabase, projeto `vzqwkckbkwtrowyykmmf` | Um único banco para preview e produção |
| Edge functions (Deno) | Supabase | Compartilhadas entre preview e produção: publicar só com OK |
| WhatsApp | Evolution API 2.3.7 na VPS (4 instâncias) | Webhook por canal apontando para `messaging-webhook-evolution` |
| Instagram e TikTok | Zernio | Direct, DMs e comentários |
| Automações externas | n8n na VPS | Agente de IA de atendimento, mensagens agendadas, entrada de leads |
| Código | GitHub `mau288/nossocrm` (fork privado de `thaleslaray/nossocrm`) | Docs privados em `mau288/arkacademy-crm-docs` |

Edge functions em produção (03/11): `messaging-webhook-evolution` v13 · `messaging-webhook-zernio` v15 · `webhook-in` v6 · `gestao-alertas` v2 · `scheduled-messages-dispatch` v2 · `messaging-webhook-meta` v4 · `messaging-webhook-resend` v4 · `messaging-webhook-zapi` v4 (as três últimas vieram do upstream e não estão em uso).

Jobs do pg_cron: `scheduled-messages-dispatch` a cada minuto (follow-ups agendados) · `gestao-alertas` a cada 10 min (a função decide se é hora de avisar) · limpeza do log do cron às 6h.

## 2. Canais ligados

| Canal | Tipo | Status em 03/11 |
|---|---|---|
| Chip Julio (espelho n8n) · 12 99168-6365 | WhatsApp / Evolution | conectado |
| Chip Pedro (espelho n8n) · 12 99205-2104 | WhatsApp / Evolution | conectado |
| Chip Raul (espelho n8n) · 11 91526-5471 | WhatsApp / Evolution | conectado |
| Suporte Comunidade Galera 4.0 — Chip Julio Oficial · 16 99281-6869 | WhatsApp / Evolution | conectado |
| Instagram @proffilipefraga | Instagram / Zernio | conectado |
| TikTok @filipe_fraga | TikTok / Zernio | conectado |

Os chips são "espelho": o atendimento acontece no aparelho ou no WhatsApp Web, o CRM recebe cópia de tudo (entrada e saída) e também envia pela tela.

## 3. Volume no banco (03/11/2026)

| | |
|---|---|
| Contatos | 3.273 (796 promovidos a contato de fato; o resto é só conversa) |
| Conversas | 3.533, das quais 3.295 abertas e 419 aguardando resposta |
| Mensagens | 11.209 |
| Funis | 3 — Formações · Consultiva (Call) · Eventos & Lançamentos |
| Negócios | 56 (16 ganhos) |
| Usuários | 4 |

## 4. O que o CRM faz hoje

**Mensagens (WhatsApp, Instagram e TikTok em uma tela)**
- Lista paginada com abas **Abertas · Não respondidas · Resolvidas**, filtros por canal, não lidas, tag do contato e período.
- Texto, áudio, imagem, vídeo, documento, figurinha (gaveta própria), reação, edição e "apagar para todos" (revoga na Evolution).
- Responder = lido, e responder logado = assumir a conversa. Resposta do agente de IA do n8n aparece como "Agente-IA".
- Tempo real com rede de segurança (recarga periódica e reassinatura quando o canal cai) e botão Atualizar.
- "Enviar pro Funil" (vira negócio só por decisão do operador), "Puxar pro WhatsApp" (lead do Instagram migra para um chip, mesclando o contato) e envio para contatos.
- Follow-up programado por conversa (robô do pg_cron dispara na hora marcada).

**Comentários**: Instagram, YouTube e TikTok lidos ao vivo pela Zernio, com resposta e ocultar/excluir.

**Contatos**: identidade única por telefone / e-mail / @instagram / @tiktok (RPC `upsert_contact_identity`), telefone normalizado com o 9, origem registrada, tags livres, ciclo de vida `conversa → contato` automático (quando o lead responde depois de uma mensagem nossa ou vira negócio). Importação por CSV com tags para todos e envio direto a um funil.

**Funis e negócios**: 3 funis com etapa de ganho e perda declaradas, dono do negócio (padrão = quem criou ou quem marcou ganho), valor, meta por funil com período e histórico de metas, progresso contando só ganhos, filtro de período no cabeçalho.

**Financeiro**: gateways de pagamento com taxa por forma e imposto padrão; no card do negócio aparece o líquido calculado na hora; a Visão Geral separa Realizado e Previsão (bruto / após taxas / após taxas e imposto).

**Gestão (Relatórios › Gestão)**: painel por vendedor e por canal, tempo de primeira resposta, pendentes, exportações, meta por vendedor, roteamento e **alertas no WhatsApp**: "aguardando resposta" em horários fixos (hoje 9h e 20h) com a lista de quem está pendente (nome, telefone, canal, tempo).

**Entrada de leads**: `webhook-in` recebe cadastros de páginas e do n8n (formações, consultiva, eventos), com tags e funil de destino; API pública para integrações.

**Identidade**: marca ARK ACADEMY, tema preto industrial e amarelo, PWA instalável no celular.

## 5. Linha do tempo das versões

| Tag | Data | O que entrou |
|---|---|---|
| v1.4 → v1.8 | ago–set/26 | Instalador, funis com ganho declarado, financeiro, mensagens por vendedor, aba Comentários |
| v1.9 → v1.11 | set–out/26 | Mídia completa, figurinhas, agente de IA visível, apagar mensagem, filtro por tag |
| v1.12 / v1.13 | 23–24/10 | TikTok em Comentários e DMs do TikTok em Mensagens |
| v1.14 | 29/10 | Meta do funil com período e histórico |
| v1.15 → v1.19 | 31/10–01/11 | Vistoria em 4 ondas: correções rápidas, performance estrutural (lista paginada, índices), regra de criação de contato e identidade única, painel de Gestão com alertas |
| v1.19.1 → v1.19.4 | 01/11 | Responder = assumir, período personalizado, alertas em horários fixos com lista de pendentes, aba Não respondidas |
| **v1.19.5** | 03/11 | Chips reconectam sozinhos no CRM; mensagens perdidas reimportadas |

## 6. Incidente de 01–03/11 (resolvido)

Em 01/11 às 14:51 os 4 chips caíram juntos na Evolution (reinício do servidor) e reconectaram sozinhos. O CRM, porém, só aceitava mensagem de chip marcado "conectado", e o aviso de reconexão era descartado como duplicado. Resultado: por 2 dias as mensagens dos chips Pedro, Julio espelho e Julio Oficial não entraram (39 mensagens recebidas de 13 leads). O Raul seguiu normal porque o status dele nunca mudou.

Correção (v13 da função): aceita o canal em qualquer status e marca "conectado" na primeira mensagem que passa; o aviso de reconexão leva data e hora. As 128 mensagens que ficaram na Evolution foram reimportadas no horário real, sem duplicar. Clicar em "Conectar" na tela de Canais não resolve esse caso; agora também não é necessário.

Ferramentas: `ferramentas-crm/evo_perdidas.py` (conta o que falta) e `ferramentas-crm/evo_replay.py` (reimporta), guardadas fora deste repositório.

## 7. Pendências e próximos passos

Pedidos abertos do Mauricio
- Layout de Mensagens no PC: as três abas não cabem e "Resolvidas" fica cortada.
- Celular: o painel lateral do contato cobre o campo de digitar a mensagem.
- Login do Filipe em Configurações › Equipe; religar a Verena nos alertas.

Técnico
- O webhook da Zernio (Instagram/TikTok) tem a mesma trava de status que derrubou os chips; ainda não deu problema, corrigir na próxima rodada.
- Compras e abandonos dos gateways (TMB, Eduzz, Hotmart, Lia) ainda não chegam ao CRM.
- Sobras da vistoria: `deals limit=1000` duas vezes na Visão Geral, `auth/v1/user` repetido, função Evolution ainda grava "Unknown error" em alguns casos.

Planejado
- **Onda 4 — IA de vendas no WhatsApp**: plano v1.1 pronto (13 produtos, 12 fichas, ofertas por público), aguardando OK para começar.
- Provedor WhatsApp uazapi como alternativa à Evolution.
- Carga do histórico antigo do Direct (hoje só entra mensagem nova).
- PR no upstream com as correções do envio preso em `queued` e do instalador.

## 8. Regras de operação

- Migration sempre por arquivo em `supabase/migrations/`, aplicada pela Management API; nada manual no banco nem no CRM.
- Escrita em dados de produção só com OK explícito; avisar antes de subir para `main`.
- Edge functions são compartilhadas entre preview e produção: publicar só com OK.
- Credenciais nunca vão para o repositório (ficam no Supabase, nas env vars da Vercel ou nos arquivos de chaves locais).
- Atualização do upstream é manual, em branch de teste com preview na Vercel.
- Toda mudança ganha uma linha em `CUSTOMIZACOES.md` e uma tag `vX.Y-nome`.
