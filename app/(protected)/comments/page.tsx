import type { Metadata } from 'next';
import { CommentsWorkspaceV3 } from '@/features/comments/CommentsWorkspaceV3';

export const metadata: Metadata = { title: 'Comentários | ARK ACADEMY' };

export default function Comments() {
  return <CommentsWorkspaceV3 />;
}
