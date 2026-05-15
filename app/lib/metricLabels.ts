export const METRIC_LABELS: Record<string, { label: string; unit: string; isPercent: boolean }> = {
  // バリュエーション
  perA:      { label: 'PER実績',           unit: '倍', isPercent: false },
  perF:      { label: 'PER今期',           unit: '倍', isPercent: false },
  perN:      { label: 'PER来期',           unit: '倍', isPercent: false },
  pbr:       { label: 'PBR',               unit: '倍', isPercent: false },
  perFChg1m: { label: 'PER今期1ヶ月変化率', unit: '%',  isPercent: true  },

  // 収益性・成長性
  roe:       { label: 'ROE',               unit: '%',  isPercent: true  },
  opMgn:     { label: '営業利益率',         unit: '%',  isPercent: true  },
  epsGr:     { label: 'EPS成長率',          unit: '%',  isPercent: true  },
  peg:       { label: 'PEG',               unit: '',   isPercent: false },
  nySalesGr: { label: '来期売上成長率',      unit: '%',  isPercent: true  },

  // 株価系（StockRow: chg1d/1w/3m/1y）
  chg1d:     { label: '前日比',             unit: '%',  isPercent: true  },
  chg1w:     { label: '1週間変化率',         unit: '%',  isPercent: true  },
  chg3m:     { label: '3ヶ月変化率',         unit: '%',  isPercent: true  },
  chg1y:     { label: '1年変化率',           unit: '%',  isPercent: true  },

  // その他（StockRow: divY / mcap）
  divY:      { label: '配当利回り',          unit: '%',  isPercent: true  },
  mcap:      { label: '時価総額(億)',        unit: '億', isPercent: false },
}

export const AVAILABLE_METRICS = Object.keys(METRIC_LABELS) as readonly string[]
export type AvailableMetric = typeof AVAILABLE_METRICS[number]
