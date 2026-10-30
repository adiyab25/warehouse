import { ActionBanner } from '@/modules/shell/ui/ActionBanner';
import { getRequestLang } from '../../../i18n/request';
import { openCountAction } from './actions';

export default async function CountsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; refused?: string }>;
}) {
  const lang = await getRequestLang();
  const { ok, refused } = await searchParams;

  return (
    <div className="p-6 max-w-2xl">
      <ActionBanner lang={lang} ok={ok === '1'} refused={refused} />
      <h1 className="text-2xl font-bold mb-4">Stock Counts</h1>
      <form action={openCountAction} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Location ID</label>
          <input name="locationId" required className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Started By (User ID)</label>
          <input name="startedBy" required className="w-full border rounded px-3 py-2" />
        </div>
        <button type="submit" className="bg-primary text-white px-4 py-2 rounded">
          Open Count Session
        </button>
      </form>
    </div>
  );
}
