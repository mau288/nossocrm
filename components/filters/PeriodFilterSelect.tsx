import React, { useEffect, useState } from 'react';
import {
    PERIOD_LABELS,
    isCustomPeriod,
    makeCustomPeriod,
    parseCustomPeriod,
    type PeriodFilter,
} from '@/features/dashboard/hooks/useDashboardMetrics';

interface PeriodFilterSelectProps {
    value: PeriodFilter;
    onChange: (period: PeriodFilter) => void;
    className?: string;
    'aria-label'?: string;
}

const CUSTOM_OPTION = '__custom__';

const hoje = () => new Date().toLocaleDateString('sv-SE');
const primeiroDiaDoMes = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

/**
 * Componente de seleção de período compartilhado.
 * Usado em Dashboard, Reports e outras páginas que precisam filtrar por período.
 *
 * ARK: opção "Personalizado" abre dois campos de data; o valor sobe como
 * `custom:AAAA-MM-DD:AAAA-MM-DD` (ver `parseCustomPeriod`).
 */
export const PeriodFilterSelect: React.FC<PeriodFilterSelectProps> = ({
    value,
    onChange,
    className = '',
    'aria-label': ariaLabel = 'Selecionar Período',
}) => {
    const custom = parseCustomPeriod(value);
    const [showCustom, setShowCustom] = useState(isCustomPeriod(value));
    const [start, setStart] = useState(custom?.start ?? primeiroDiaDoMes());
    const [end, setEnd] = useState(custom?.end ?? hoje());

    useEffect(() => {
        if (custom) {
            setStart(custom.start);
            setEnd(custom.end);
            setShowCustom(true);
        }
    }, [custom?.start, custom?.end]); // eslint-disable-line react-hooks/exhaustive-deps

    const emit = (s: string, e: string) => {
        if (s && e) onChange(makeCustomPeriod(s, e));
    };

    const selectCls = `px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500 ${className}`;
    const dateCls =
        'px-2 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500';

    return (
        <div className="flex items-center gap-2">
            <select
                value={showCustom ? CUSTOM_OPTION : value}
                onChange={(e) => {
                    if (e.target.value === CUSTOM_OPTION) {
                        setShowCustom(true);
                        emit(start, end);
                    } else {
                        setShowCustom(false);
                        onChange(e.target.value as PeriodFilter);
                    }
                }}
                aria-label={ariaLabel}
                className={selectCls}
            >
                {Object.entries(PERIOD_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                        {label}
                    </option>
                ))}
                <option value={CUSTOM_OPTION}>Personalizado…</option>
            </select>
            {showCustom && (
                <>
                    <input
                        type="date"
                        value={start}
                        max={end || undefined}
                        onChange={(e) => {
                            setStart(e.target.value);
                            emit(e.target.value, end);
                        }}
                        aria-label="Data inicial"
                        className={dateCls}
                    />
                    <span className="text-xs text-slate-400">até</span>
                    <input
                        type="date"
                        value={end}
                        min={start || undefined}
                        onChange={(e) => {
                            setEnd(e.target.value);
                            emit(start, e.target.value);
                        }}
                        aria-label="Data final"
                        className={dateCls}
                    />
                </>
            )}
        </div>
    );
};

export default PeriodFilterSelect;
