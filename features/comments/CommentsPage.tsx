'use client';

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Instagram, MessageCircle, RefreshCw, Youtube } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type CommentEvent = {
  id: string;
  created_at: string;
  payload: Record<string, unknown>;
};

type Comment = {
  id: string;
  text: string;
  author: string;
  username: string | null;
  platform: string;
  createdAt: string;
  postUrl: string | null;
  postText: string | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalize(event: CommentEvent): Comment | null {
  const comment = record(event.payload.comment);
  const author = record(comment.author ?? comment.from);
  const post = record(event.payload.post);
  const platform = text(comment.platform) ?? text(post.platform) ?? text(event.payload.platform) ?? 'social';
  const id = text(comment.id) ?? event.id;
  const body = text(comment.text) ?? text(comment.message) ?? text(comment.content);
  if (!body) return null;
  return {
    id,
    text: body,
    author: text(author.name) ?? text(author.username) ?? 'Usuário',
    username: text(author.username),
    platform,
    createdAt: text(comment.createdAt) ?? text(comment.createdTime) ?? text(event.payload.timestamp) ?? event.created_at,
    postUrl: text(post.permalink) ?? text(post.url) ?? text(comment.postUrl),
    postText: text(post.content) ?? text(post.caption) ?? text(post.title),
  };
}

export function CommentsPage() {
  const [events, setEvents] = useState<CommentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const { data, error: queryError } = await supabase
      .from('messaging_webhook_events')
      .select('id, created_at, payload')
      .eq('event_type', 'comment.received')
      .order('created_at', { ascending: false })
      .limit(200);
    if (queryError) setError('Não foi possível carregar os comentários.');
    setEvents((data ?? []) as CommentEvent[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);
  const comments = useMemo(() => events.map(normalize).filter((item): item is Comment => item !== null), [events]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Comentários</h1>
          <p className="mt-1 text-slate-500 dark:text-slate-400">Interações públicas recebidas pelas redes conectadas.</p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800">
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Atualizar
        </button>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {!loading && !error && comments.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center text-slate-500 dark:border-slate-700">Nenhum comentário espelhado ainda.</div>}
      <div className="space-y-3">
        {comments.map((comment) => {
          const isYoutube = comment.platform.toLowerCase() === 'youtube';
          const Icon = isYoutube ? Youtube : comment.platform.toLowerCase() === 'instagram' ? Instagram : MessageCircle;
          return <article key={comment.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white"><Icon className="h-4 w-4" /> {comment.author}{comment.username && <span className="font-normal text-slate-500">@{comment.username}</span>}</div>
              <time className="text-xs text-slate-500">{new Date(comment.createdAt).toLocaleString('pt-BR')}</time>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-slate-700 dark:text-slate-200">{comment.text}</p>
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500"><span className="truncate">{comment.postText ?? comment.platform}</span>{comment.postUrl && <a href={comment.postUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-primary-600 hover:underline">Abrir post <ExternalLink className="h-3 w-3" /></a>}</div>
          </article>;
        })}
      </div>
    </div>
  );
}
