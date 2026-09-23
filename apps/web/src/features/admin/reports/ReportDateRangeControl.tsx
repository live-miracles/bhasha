export interface ReportDateRangeValue {
    from: string;
    to: string;
}

const PRESETS = [
    'All time',
    'Last 5 minutes',
    'Last 30 minutes',
    'Last 1 hour',
    'Last 6 hours',
    'Last 12 hours',
    'Last 24 hours',
    'Today',
    'Last 7 days',
    'Custom',
] as const;

export type ReportDateRangePreset = (typeof PRESETS)[number];

interface ReportDateRangeControlProps {
    value: ReportDateRangeValue;
    preset: ReportDateRangePreset;
    onChange: (value: ReportDateRangeValue) => void;
    onPresetChange?: (preset: ReportDateRangePreset) => void;
}

export function ReportDateRangeControl({
    value,
    preset,
    onChange,
    onPresetChange,
}: ReportDateRangeControlProps) {
    function handlePresetChange(nextPreset: ReportDateRangePreset) {
        onPresetChange?.(nextPreset);
    }

    function handleCustomChange(next: ReportDateRangeValue) {
        onChange(next);
        onPresetChange?.('Custom');
    }

    return (
        <div className="admin-report-range-control" aria-label="Report range controls">
            <label className="admin-filter-field admin-report-range-select">
                <span className="admin-filter-field-label">Range</span>
                <select
                    value={preset}
                    onChange={(event) =>
                        handlePresetChange(event.target.value as ReportDateRangePreset)
                    }
                >
                    {PRESETS.map((preset) => (
                        <option key={preset} value={preset}>
                            {preset}
                        </option>
                    ))}
                </select>
            </label>
            {preset === 'Custom' ? (
                <div className="admin-report-range-custom">
                    <label className="admin-filter-field">
                        <span className="admin-filter-field-label">From</span>
                        <input
                            aria-label="From"
                            type="datetime-local"
                            step="60"
                            value={value.from}
                            onChange={(event) =>
                                handleCustomChange({ ...value, from: event.target.value })
                            }
                            onBlur={(event) =>
                                handleCustomChange({ ...value, from: event.target.value })
                            }
                        />
                        <span className="admin-hint">(IST)</span>
                    </label>
                    <label className="admin-filter-field">
                        <span className="admin-filter-field-label">To</span>
                        <input
                            aria-label="To"
                            type="datetime-local"
                            step="60"
                            value={value.to}
                            onChange={(event) =>
                                handleCustomChange({ ...value, to: event.target.value })
                            }
                            onBlur={(event) =>
                                handleCustomChange({ ...value, to: event.target.value })
                            }
                        />
                        <span className="admin-hint">(IST)</span>
                    </label>
                </div>
            ) : null}
        </div>
    );
}
