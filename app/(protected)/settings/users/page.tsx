import type { Metadata } from 'next';
import SettingsPage from '@/features/settings/SettingsPage'

export const metadata: Metadata = { title: 'Equipe | ARK ACADEMY' };

export default function SettingsUsers() {
  return <SettingsPage tab="users" />
}
