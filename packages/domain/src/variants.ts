export type VariantOptions = Record<string, string>

export function variantOptions(value: unknown): VariantOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide option names and values.')
  const entries = Object.entries(value)
  if (entries.length < 1 || entries.length > 4) throw new Error('Use between one and four options per variant.')
  const seen = new Set<string>()
  const normalized = entries.map(([key, raw]) => {
    const name = key.trim()
    const option = typeof raw === 'string' ? raw.trim() : ''
    if (!name || name.length > 24 || !option || option.length > 40 || /[\u0000-\u001f]/.test(name + option)) throw new Error('Option names must be 1–24 characters and values 1–40 characters.')
    if (seen.has(name.toLowerCase())) throw new Error('Each option name must be unique.')
    seen.add(name.toLowerCase())
    return [name, option] as const
  })
  return Object.fromEntries(normalized.sort(([a], [b]) => a.localeCompare(b, 'en')))
}

export function optionLabel(options: VariantOptions): string {
  return Object.entries(options).map(([key, value]) => `${key}: ${value}`).join(' / ')
}

export function variantName(parent: string, options: VariantOptions): string {
  const name = `${parent} — ${optionLabel(options)}`
  if (name.length > 160) throw new Error('Parent name and options together must be at most 160 characters.')
  return name
}
