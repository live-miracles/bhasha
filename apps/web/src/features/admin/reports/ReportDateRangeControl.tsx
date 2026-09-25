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
        <Stack aria-label="Report range controls">
            <NativeSelect
                aria-label="Range"
                label="Range"
                value={preset}
                onChange={(event) =>
                    handlePresetChange(event.target.value as ReportDateRangePreset)
                }
                data={PRESETS.map((preset) => ({ label: preset, value: preset }))}
            />
            {preset === 'Custom' ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <TextInput
                        aria-label="From"
                        label="From (IST)"
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
                    <TextInput
                        aria-label="To"
                        label="To (IST)"
                        type="datetime-local"
                        step="60"
                        value={value.to}
                        onChange={(event) =>
                            handleCustomChange({ ...value, to: event.target.value })
                        }
                        onBlur={(event) => handleCustomChange({ ...value, to: event.target.value })}
                    />
                </SimpleGrid>
            ) : null}
        </Stack>
    );
}
import { NativeSelect, SimpleGrid, Stack, TextInput } from '@mantine/core';
