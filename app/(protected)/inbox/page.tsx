import type { Metadata } from 'next';
import { InboxPage } from '@/features/inbox/InboxPage'

export const metadata: Metadata = { title: 'Inbox | ARK ACADEMY' };

export default function Inbox() {
    return <InboxPage />
}
