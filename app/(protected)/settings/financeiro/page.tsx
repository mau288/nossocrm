import type { Metadata } from 'next';
import SettingsPage from '@/features/settings/SettingsPage'

export const metadata: Metadata = { title: 'Financeiro | ARK ACADEMY' };

export default function SettingsFinanceiro() {
  return <SettingsPage tab="gateways" />
}
