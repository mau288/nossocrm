import { Suspense } from 'react';
import { Metadata } from 'next';
import { MessagingPage } from '@/features/messaging/MessagingPage';
import { MessageThreadSkeleton } from '@/features/messaging/components';

interface NewConversationPageProps {
  searchParams: Promise<{
    contactId?: string;
    contactName?: string;
    contactPhone?: string;
  }>;
}

export const metadata: Metadata = {
  title: 'Nova conversa | ARK ACADEMY',
  description: 'Iniciar conversa com contato',
};

/**
 * Rota dedicada para iniciar conversa a partir de um contato/deal.
 * Ela evita depender da leitura tardia da query string na página genérica.
 */
export default async function NewConversationPage({ searchParams }: NewConversationPageProps) {
  const params = await searchParams;

  return (
    <Suspense fallback={<MessageThreadSkeleton />}>
      <MessagingPage
        startConversationFor={{
          id: params.contactId || '',
          name: params.contactName || '',
          phone: params.contactPhone || '',
        }}
      />
    </Suspense>
  );
}
