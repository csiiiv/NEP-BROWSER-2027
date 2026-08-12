export function formatAmountP(pesos: number | null | undefined): string {
  if (pesos == null || Number.isNaN(Number(pesos))) return "₱0.00";
  const n = Number(pesos);
  if (n === 0) return "₱0.00";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}₱${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}₱${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}₱${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}₱${(abs / 1e3).toFixed(2)}K`;
  return `${sign}₱${abs.toFixed(2)}`;
}

export function formatAmountT(trillions: number | null | undefined): string {
  return formatAmountP((Number(trillions) || 0) * 1e12);
}

export function formatNum(n: number): string {
  return Number(n).toLocaleString();
}

export const KIND_LABELS: Record<string, string> = {
  root: "Total",
  section: "Section",
  aa_item: "AA",
  dept: "Dept",
  agency: "Agency",
  region: "Region",
  division: "Div",
  ou: "OU",
  program: "Prog",
};

export function displayCode(node: { code?: string; kind?: string }): string | null {
  if (!node.code || node.kind === "root" || node.kind === "section") return null;
  const c = String(node.code);
  if (c.includes("|")) return c.split("|").pop() || c;
  if (c.length > 14) return `${c.slice(0, 10)}…`;
  return c;
}

export function nodeKey(node: { key?: string; kind: string; code: string }): string {
  return node.key || `${node.kind}:${node.code}`;
}
