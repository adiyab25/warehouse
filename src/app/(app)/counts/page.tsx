import { openCountAction } from './actions';

export default function CountsPage() {
  return (
    <div className="p-6 max-w-2xl">
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
