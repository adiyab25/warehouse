import { createItemAction } from './actions';

export default function ItemsPage() {
  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">Items Management</h1>
      <form action={createItemAction} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Name (Arabic)</label>
          <input name="nameAr" required className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">SKU</label>
          <input name="sku" required placeholder="AB-0001" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Barcode</label>
          <input name="barcode" required placeholder="AB-0001" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Family</label>
          <input name="family" required className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Unit (uom)</label>
          <input name="uom" defaultValue="unit" className="w-full border rounded px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Unit Cost (EGP)</label>
          <input name="unitCost" type="number" step="0.01" className="w-full border rounded px-3 py-2" />
        </div>
        <button type="submit" className="bg-primary text-white px-4 py-2 rounded">
          Create Item
        </button>
      </form>
    </div>
  );
}
