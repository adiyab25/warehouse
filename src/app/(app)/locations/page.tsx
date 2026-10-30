import { ActionBanner } from '@/modules/shell/ui/ActionBanner';
import { getRequestLang } from '../../../i18n/request';
import { createLocationAction } from './actions';

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; refused?: string }>;
}) {
  const lang = await getRequestLang();
  const { ok, refused } = await searchParams;

  return (
    <div className="p-6 max-w-2xl">
      <ActionBanner lang={lang} ok={ok === '1'} refused={refused} />
      <h1 className="text-2xl font-bold mb-4">Locations Management</h1>
      <form action={createLocationAction} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Code</label>
          <input name="code" required placeholder="BR-15" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Name (Arabic)</label>
          <input name="nameAr" required className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Name (English)</label>
          <input name="nameEn" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Type</label>
          <select name="type" className="w-full border rounded px-3 py-2">
            <option value="branch">Branch</option>
            <option value="warehouse">Warehouse</option>
            <option value="quarantine">Quarantine</option>
          </select>
        </div>
        <button type="submit" className="bg-primary text-white px-4 py-2 rounded">
          Create Location
        </button>
      </form>
    </div>
  );
}
