export function Money({ value }: { value: number | string }) {
  return <span className="tabular-nums">{Number(value).toFixed(2)}</span>;
}
export function Qty({ value }: { value: number | string }) {
  return <span className="tabular-nums">{value}</span>;
}
export function DateTime({ value }: { value: string | Date }) {
  const d = value instanceof Date ? value : new Date(value);
  return <span>{d.toLocaleString()}</span>;
}