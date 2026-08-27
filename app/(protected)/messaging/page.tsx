import type { Metadata } from 'next';
import { MessagingPage } from '@/features/messaging/MessagingPage'

export const metadata: Metadata = { title: 'Mensagens | ARK ACADEMY' };

export default function Messaging() {
    return <MessagingPage />
}
