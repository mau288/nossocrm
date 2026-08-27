import type { Metadata } from 'next';
import DashboardPage from '@/features/dashboard/DashboardPage'

export const metadata: Metadata = { title: 'Dashboard | ARK ACADEMY' };

export default function Dashboard() {
    return <DashboardPage />
}
