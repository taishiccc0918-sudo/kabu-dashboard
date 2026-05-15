export const AVAILABLE_METRICS = ['perF', 'perN', 'pbr', 'roe'] as const
export type AvailableMetric = typeof AVAILABLE_METRICS[number]

export const METRIC_LABELS: Record<string, { label: string; unit: string; isPercent: boolean }> = {
  perF: { label: 'PER今期', unit: '倍', isPercent: false },
  perN: { label: 'PER来期', unit: '倍', isPercent: false },
  pbr:  { label: 'PBR',    unit: '倍', isPercent: false },
  roe:  { label: 'ROE',    unit: '%',  isPercent: true  },
}
