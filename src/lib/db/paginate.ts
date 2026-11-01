/**
 * PostgREST (Supabase) returns at most 1000 rows per request by default, and
 * silently truncates beyond that. fetchAll pages with .range() until a short
 * page comes back. The query passed in must have a stable order.
 */
export const PAGE_ROWS = 1000;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchAll<T = any>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  size = PAGE_ROWS,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(`Database error: ${error.message ?? error}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}
