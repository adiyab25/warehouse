import { ActionBanner } from '@/modules/shell/ui/ActionBanner';
import { getRequestLang } from '../../../i18n/request';
import { createReturnAction } from './actions';

export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; refused?: string }>;
}) {
  const lang = await getRequestLang();
  const { ok, refused } = await searchParams;

  return (
    <div className="p-6 max-w-2xl">
      <ActionBanner lang={lang} ok={ok === '1'} refused={refused} />
      <h1 className="text-2xl font-bold mb-4">Returns</h1>
      <form action={createReturnAction} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Variant ID</label>
          <input name="variantId" required className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Qty</label>
          <input name="qty" type="number" step="0.001" required className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">From Location ID</label>
          <input name="fromLocationId" required className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Disposition</label>
          <select name="disposition" className="w-full border rounded px-3 py-2">
            <option value="restock">Restock</option>
            <option value="quarantine">Quarantine</option>
            <option value="scrap">Scrap</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Notes</label>
          <textarea name="notes" className="w-full border rounded px-3 py-2" />
        </div>
        <button type="submit" className="bg-primary text-white px-4 py-2 rounded">
          Create Return
        </button>
      </form>
    </div>
  );
}
