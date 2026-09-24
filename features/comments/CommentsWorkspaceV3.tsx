'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, EyeOff, Instagram, MessageCircle, RefreshCw, Reply, Send, ThumbsUp, Trash2, Youtube } from 'lucide-react';

type Platform = 'all' | 'instagram' | 'youtube';
type Post = { id: string; platform: 'instagram' | 'youtube'; accountId: string; accountUsername?: string; content?: string; picture?: string; permalink?: string; commentCount?: number };
type ThreadComment = { id: string; message?: string; createdTime?: string; likeCount?: number; from?: { name?: string; username?: string; picture?: string; isOwner?: boolean }; replies?: ThreadComment[] };
type CommentAction = 'hide' | 'delete';

const platformIcon = (platform: string) => platform === 'youtube' ? Youtube : Instagram;
const preview = (content?: string) => content && content.length > 98 ? `${content.slice(0, 98)}…` : content || 'Post sem texto';
const threadCount = (items: ThreadComment[]) => items.reduce((count, item) => count + 1 + threadCount(item.replies ?? []), 0);

function decodeEntities(value: string) {
  return value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function plainText(value: string) {
  return decodeEntities(value.replace(/<[^>]*>/g, ''));
}

function safeUrl(value: string) {
  try { const url = new URL(decodeEntities(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function linkify(value: string, keyPrefix: string): ReactNode[] {
  const parts = value.split(/(https?:\/\/[^\s<]+)/gi);
  return parts.map((part, index) => {
    const url = safeUrl(part);
    return url ? <a key={`${keyPrefix}-${index}`} href={url} target="_blank" rel="noreferrer" className="break-all text-sky-600 underline hover:text-sky-500">{part}</a> : part;
  });
}

function renderMessage(message?: string): ReactNode[] {
  const source = (message ?? 'Comentário sem texto').replace(/<br\s*\/?>/gi, '\n');
  const nodes: ReactNode[] = []; let cursor = 0; let index = 0;
  const anchors = /<a\s+[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (let match = anchors.exec(source); match; match = anchors.exec(source)) {
    if (match.index > cursor) nodes.push(...linkify(plainText(source.slice(cursor, match.index)), `text-${index++}`));
    const url = safeUrl(match[2]); const label = plainText(match[3]) || url || 'Abrir link';
    nodes.push(url ? <a key={`anchor-${index++}`} href={url} target="_blank" rel="noreferrer" className="break-all text-sky-600 underline hover:text-sky-500">{label}</a> : label);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) nodes.push(...linkify(plainText(source.slice(cursor)), `text-${index++}`));
  return nodes;
}

export function CommentsWorkspaceV3() {
  const [platform, setPlatform] = useState<Platform>('all');
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [selected, setSelected] = useState<Post | null>(null);
  const [comments, setComments] = useState<ThreadComment[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replyTarget, setReplyTarget] = useState<ThreadComment | null>(null);
  const [sending, setSending] = useState(false);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const total = useMemo(() => threadCount(comments), [comments]);

  const loadPosts = useCallback(async () => {
    setLoadingPosts(true); setError(null);
    const query = new URLSearchParams();
    if (platform !== 'all') query.set('platform', platform);
    if (includeEmpty) query.set('includeEmpty', 'true');
    const response = await fetch(`/api/comments/posts${query.size ? `?${query}` : ''}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setPosts([]); setError(data.message ?? 'Não foi possível carregar os posts.'); }
    else {
      const next: Post[] = data.posts ?? [];
      setPosts(next);
      setSelected((current) => next.find((post) => post.id === current?.id && post.accountId === current?.accountId) ?? next[0] ?? null);
    }
    setLoadingPosts(false);
  }, [includeEmpty, platform]);

  const loadThread = useCallback(async () => {
    if (!selected) { setComments([]); return; }
    setLoadingThread(true); setError(null);
    const response = await fetch(`/api/comments/posts/${encodeURIComponent(selected.id)}?accountId=${encodeURIComponent(selected.accountId)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setComments([]); setError(data.message ?? 'Não foi possível carregar os comentários.'); }
    else setComments(data.comments ?? []);
    setLoadingThread(false);
  }, [selected]);

  useEffect(() => { void loadPosts(); }, [loadPosts]);
  useEffect(() => { void loadThread(); }, [loadThread]);
  useEffect(() => { setDraft(''); setReplyTarget(null); }, [selected?.id, selected?.accountId]);

  const sendReply = async () => {
    if (!selected || !draft.trim() || comments.length === 0) return;
    const target = replyTarget ?? comments[0];
    setSending(true); setError(null);
    const response = await fetch('/api/comments/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postId: selected.id, commentId: target.id, accountId: selected.accountId, message: draft.trim() }) });
    const data = await response.json().catch(() => ({}));
    setSending(false);
    if (!response.ok) { setError(data.message ?? 'Não foi possível enviar a resposta.'); return; }
    setDraft(''); setReplyTarget(null); await loadThread();
  };

  const executeAction = async (action: CommentAction, comment: ThreadComment) => {
    if (!selected) return;
    if (action === 'delete' && !window.confirm('Excluir esta resposta permanentemente?')) return;
    setActingOn(`${action}:${comment.id}`); setError(null);
    const response = await fetch('/api/comments/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, postId: selected.id, commentId: comment.id, accountId: selected.accountId }) });
    const data = await response.json().catch(() => ({}));
    setActingOn(null);
    if (!response.ok) { setError(data.message ?? 'Não foi possível executar a ação.'); return; }
    await loadThread();
  };

  return <div className="flex h-[calc(100vh-4rem)] min-h-[650px] overflow-hidden bg-[#111827] text-slate-100">
    <aside className="flex w-[38%] min-w-[350px] max-w-[560px] flex-col border-r border-slate-700 bg-[#111827]">
      <div className="border-b border-slate-700 p-4"><h1 className="text-xl font-bold">Comentários</h1><div className="mt-3 flex items-center gap-2"><label className="relative"><select aria-label="Filtrar plataforma" value={platform} onChange={(event) => setPlatform(event.target.value as Platform)} className="appearance-none rounded-md border border-slate-600 bg-[#161d2b] py-2 pl-3 pr-8 text-sm text-slate-100"><option value="all">Todas as plataformas</option><option value="instagram">Instagram</option><option value="youtube">YouTube</option></select><ChevronDown className="pointer-events-none absolute right-2 top-2.5 h-4 w-4" /></label><button onClick={() => void loadPosts()} className="rounded-md border border-slate-600 p-2 hover:bg-slate-800" title="Atualizar"><RefreshCw className={loadingPosts ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /></button></div><label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={includeEmpty} onChange={(event) => setIncludeEmpty(event.target.checked)} className="accent-orange-600" /> Incluir posts sem comentários</label></div>
      <div className="flex-1 overflow-y-auto">{posts.map((post) => { const Icon = platformIcon(post.platform); const active = selected?.id === post.id && selected?.accountId === post.accountId; return <button key={`${post.platform}-${post.accountId}-${post.id}`} onClick={() => setSelected(post)} className={`flex w-full gap-3 border-b border-slate-800 p-3 text-left transition ${active ? 'bg-slate-700/70' : 'hover:bg-slate-800/70'}`}><div className="h-14 w-14 shrink-0 overflow-hidden rounded bg-slate-700">{post.picture ? <img src={post.picture} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center"><Icon className="h-5 w-5" /></div>}</div><div className="min-w-0 flex-1"><p className="line-clamp-2 text-sm font-semibold leading-5">{preview(post.content)}</p><div className="mt-1 flex items-center gap-1 text-xs text-slate-400"><Icon className="h-3.5 w-3.5" /> @{post.accountUsername} <span className="ml-2 inline-flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> {post.commentCount ?? 0}</span></div></div></button>; })}{!loadingPosts && posts.length === 0 && <p className="p-6 text-center text-sm text-slate-400">Nenhum post encontrado para este filtro.</p>}</div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col bg-[#171717]">{selected ? <>
      <header className="flex items-center justify-between border-b border-slate-700 px-5 py-4"><div><h2 className="font-semibold">Comentários ({total})</h2><p className="mt-1 line-clamp-1 text-xs text-slate-400">{selected.content}</p></div>{selected.permalink && <a href={selected.permalink} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-white"><ExternalLink className="h-4 w-4" /></a>}</header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">{loadingThread ? <p className="text-sm text-slate-400">Carregando comentários…</p> : comments.map((comment) => <ThreadCard key={comment.id} comment={comment} platform={selected.platform} depth={0} actingOn={actingOn} onReply={(target) => { setReplyTarget(target); setDraft(''); }} onAction={executeAction} />)}{!loadingThread && comments.length === 0 && <p className="text-sm text-slate-400">Este post ainda não tem comentários.</p>}</div>
      <div className="border-t border-slate-700 p-4"><div className="mb-2 flex items-center justify-between text-xs text-slate-400">{replyTarget ? <span>Respondendo a <strong className="text-slate-200">@{replyTarget.from?.username ?? replyTarget.from?.name ?? 'usuário'}</strong></span> : <span>Responder ao comentário selecionado</span>}{replyTarget && <button onClick={() => setReplyTarget(null)} className="hover:text-white">Cancelar</button>}</div><div className="flex rounded-xl border border-slate-600 bg-[#111827] p-1"><input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendReply(); } }} placeholder={replyTarget ? 'Escreva sua resposta…' : 'Escreva um comentário…'} className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none" /><button disabled={sending || !draft.trim() || comments.length === 0} onClick={() => void sendReply()} className="rounded-lg bg-orange-700 p-2 text-white disabled:opacity-40"><Send className="h-5 w-5" /></button></div></div>
    </> : <div className="flex flex-1 items-center justify-center text-slate-400">Selecione um post para abrir a thread.</div>}</main>
    {error && <div className="fixed bottom-4 right-4 max-w-sm rounded-lg bg-red-600 px-4 py-3 text-sm text-white shadow-xl">{error}</div>}
  </div>;
}

function ThreadCard({ comment, platform, depth, actingOn, onReply, onAction }: { comment: ThreadComment; platform: string; depth: number; actingOn: string | null; onReply: (comment: ThreadComment) => void; onAction: (action: CommentAction, comment: ThreadComment) => void }) {
  const Icon = platformIcon(platform);
  const isOwner = Boolean(comment.from?.isOwner);
  const author = comment.from?.name ?? comment.from?.username ?? 'Usuário';
  const canHide = platform === 'instagram' && !isOwner;
  const likeLabel = comment.likeCount === 1 ? '1 curtida' : `${comment.likeCount ?? 0} curtidas`;
  return <div className={depth > 0 ? 'ml-6 border-l border-slate-600 pl-3' : ''}>
    <article className={`rounded-md border p-4 ${isOwner ? 'border-stone-300 bg-stone-100 text-stone-900' : 'border-slate-700 bg-[#252525]'}`}>
      <div className="flex items-start gap-3">
        {comment.from?.picture ? <img src={comment.from.picture} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-700"><Icon className="h-4 w-4" /></div>}
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{author} {isOwner && <span className="ml-1 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">Você</span>}</div>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{renderMessage(comment.message)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-70">
            <time>{comment.createdTime ? new Date(comment.createdTime).toLocaleString('pt-BR') : ''}</time>
            {(comment.likeCount ?? 0) > 0 && <span className="inline-flex items-center gap-1" title={platform === 'youtube' ? 'A API do YouTube não permite curtir comentários' : likeLabel}><ThumbsUp className="h-3.5 w-3.5" />{comment.likeCount}</span>}
            <button onClick={() => onReply(comment)} className="inline-flex items-center gap-1 font-medium hover:opacity-100"><Reply className="h-3.5 w-3.5" />Responder</button>
            {canHide && <button disabled={actingOn === `hide:${comment.id}`} onClick={() => onAction('hide', comment)} className="inline-flex items-center gap-1 font-medium hover:opacity-100 disabled:opacity-40"><EyeOff className="h-3.5 w-3.5" />Ocultar</button>}
            {isOwner && <button disabled={actingOn === `delete:${comment.id}`} onClick={() => onAction('delete', comment)} className="inline-flex items-center gap-1 font-medium text-red-500 hover:opacity-100 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />Excluir</button>}
          </div>
        </div>
      </div>
    </article>
    {comment.replies?.length ? <div className="mt-3 space-y-3">{comment.replies.map((reply) => <ThreadCard key={reply.id} comment={reply} platform={platform} depth={depth + 1} actingOn={actingOn} onReply={onReply} onAction={onAction} />)}</div> : null}
  </div>;
}
