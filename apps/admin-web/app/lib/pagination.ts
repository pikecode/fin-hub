/** Load complete data for operations that need all records, honoring server page caps. */
export async function loadAllPages<T>(
  loader: (page: number, pageSize: number) => Promise<{ items: T[]; total: number }>,
  isCurrent: () => boolean = () => true,
): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let total = Infinity;
  for (let page = 1; items.length < total; page += 1) {
    if (!isCurrent()) throw new Error("请求已被更新的查询替代");
    const result = await loader(page, 200);
    if (!isCurrent()) throw new Error("请求已被更新的查询替代");
    total = result.total;
    items.push(...result.items);
    if (!result.items.length) break;
  }
  return { items, total: Number.isFinite(total) ? total : items.length };
}
