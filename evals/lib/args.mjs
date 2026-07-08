export function parseArgs(argv) {
  const o = { smoke: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') o.smoke = true;
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--case') o.case = argv[++i];
    else if (a === '--k') o.k = Number(argv[++i]);
    else if (a === '--json') o.json = argv[++i];
  }
  return o;
}

export function effectiveK(caseDef, opts) {
  if (opts.smoke) return 1;
  if (opts.k) return opts.k;
  return caseDef.k ?? 1;
}
