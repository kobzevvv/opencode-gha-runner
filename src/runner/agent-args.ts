/** The accepted run's model takes precedence over repository defaults. */
export function agentArguments(defaults: string[], model: string | undefined, prompt: string): string[] {
  if (model === undefined) return [...defaults, 'run', prompt];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw new Error('invalid engine model');
  const flags: string[] = [];
  for (let index = 0; index < defaults.length; index++) {
    const flag = defaults[index]!;
    if (flag === '-m' || flag === '--model') { index++; continue; }
    if (flag.startsWith('--model=') || /^-m.+/.test(flag)) continue;
    flags.push(flag);
  }
  const selected = model.includes('/') ? model : `ladder/${model}`;
  return [...flags, '-m', selected, 'run', prompt];
}
