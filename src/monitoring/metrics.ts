type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue>;

interface MetricSample {
  labels: Labels;
  value: number;
}

function sanitizeLabelValue(value: LabelValue) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function labelsKey(labels: Labels = {}) {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function formatLabels(labels: Labels = {}) {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${sanitizeLabelValue(v)}"`).join(',')}}`;
}

export class CounterMetric {
  name: string;
  help: string;
  type: 'counter';
  samples: Map<string, MetricSample>;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
    this.type = 'counter';
    this.samples = new Map();
  }

  inc(value = 1, labels: Labels = {}) {
    const key = labelsKey(labels);
    const prev = this.samples.get(key) ?? { labels, value: 0 };
    prev.value += value;
    this.samples.set(key, prev);
  }
}

export class GaugeMetric {
  name: string;
  help: string;
  type: 'gauge';
  samples: Map<string, MetricSample>;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
    this.type = 'gauge';
    this.samples = new Map();
  }

  set(value: number, labels: Labels = {}) {
    const key = labelsKey(labels);
    this.samples.set(key, { labels, value });
  }

  inc(value = 1, labels: Labels = {}) {
    const key = labelsKey(labels);
    const prev = this.samples.get(key) ?? { labels, value: 0 };
    prev.value += value;
    this.samples.set(key, prev);
  }

  dec(value = 1, labels: Labels = {}) {
    this.inc(-value, labels);
  }
}

export class MetricsRegistry {
  prefix: string;
  metrics: Map<string, CounterMetric | GaugeMetric>;

  constructor(options: { prefix?: string } = {}) {
    this.prefix = options.prefix ?? 'fluxer_bot_';
    this.metrics = new Map();
  }

  counter(name: string, help: string): CounterMetric {
    const full = `${this.prefix}${name}`;
    const existing = this.metrics.get(full);
    if (existing instanceof CounterMetric) return existing;
    const metric = new CounterMetric(full, help);
    this.metrics.set(full, metric);
    return metric;
  }

  gauge(name: string, help: string): GaugeMetric {
    const full = `${this.prefix}${name}`;
    const existing = this.metrics.get(full);
    if (existing instanceof GaugeMetric) return existing;
    const metric = new GaugeMetric(full, help);
    this.metrics.set(full, metric);
    return metric;
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      if (metric.samples.size === 0) {
        lines.push(`${metric.name} 0`);
        continue;
      }

      for (const sample of metric.samples.values()) {
        lines.push(`${metric.name}${formatLabels(sample.labels)} ${sample.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}




